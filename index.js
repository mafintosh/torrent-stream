var magnet = require('magnet-uri');
var hat = require('hat');
var pws = require('peer-wire-swarm');
var bncode = require('bncode');
var crypto = require('crypto');
var bitfield = require('bitfield');
var parseTorrent = require('parse-torrent');
var mkdirp = require('mkdirp');
var rimraf = require('rimraf');
var events = require('events');
var path = require('path');
var fs = require('fs');
var os = require('os');
var eos = require('end-of-stream');
var ip = require('ip');
var dht = require('bittorrent-dht');
var tracker = require('bittorrent-tracker');
var encode = require('./encode-metadata');
var storage = require('./storage');
var fileStream = require('./file-stream');
var piece = require('./piece');

var MAX_REQUESTS = 5;
var CHOKE_TIMEOUT = 5000;
var REQUEST_TIMEOUT = 30000;
var SPEED_THRESHOLD = 3 * piece.BLOCK_SIZE;
var DEFAULT_PORT = 6881;
var DHT_SIZE = 10000;

var METADATA_BLOCK_SIZE = 1 << 14;
var METADATA_MAX_SIZE = 1 << 22;
var TMP = fs.existsSync('/tmp') ? '/tmp' : os.tmpDir();

var EXTENSIONS = {
	m: {
		ut_metadata: 1
	}
};

var noop = function() {};

var sha1 = function(data) {
	return crypto.createHash('sha1').update(data).digest('hex');
};

var thruthy = function() {
	return true;
};

var falsy = function() {
	return false;
};

var toNumber = function(val) {
	return val === true ? 1 : (val || 0);
};

var isPeerBlocked = function(addr, blocklist) {
	var blockedReason = null;
	// TODO: support IPv6
	var searchAddr = ip.toLong(addr);
	for (var i = 0, l = blocklist.length; i < l; i++) {
		var block = blocklist[i];
		if (!block.startAddress || !block.endAddress) continue;
		var startAddress = ip.toLong(block.startAddress);
		var endAddress = ip.toLong(block.endAddress);
		if (searchAddr >= startAddress && searchAddr <= endAddress) {
			blockedReason = block.reason || true;
			break;
		}
	}
	return blockedReason;
};

var torrentStream = function(link, opts) {
	link = typeof link === 'string' ? magnet(link) : Buffer.isBuffer(link) ? parseTorrent(link) : link;

	if (!link || !link.infoHash) throw new Error('You must pass a valid torrent or magnet link');

	var infoHash = link.infoHash;

	if (!opts) opts = {};
	if (!opts.id) opts.id = '-TS0008-'+hat(48);
	if (!opts.path) opts.path = path.join(opts.tmp || TMP, opts.name || 'torrent-stream', infoHash);
	if (!opts.blocklist) opts.blocklist = [];

	var engine = new events.EventEmitter();
	var swarm = pws(infoHash, opts.id, {size:opts.connections || opts.size});
	var torrentPath = path.join(opts.path, 'cache.torrent');

	var wires = swarm.wires;
	var critical = [];
	var metadataPieces = [];
	var metadata = null;
	var refresh = noop;

	engine.path = opts.path;
	engine.files = [];
	engine.selection = [];
	engine.torrent = null;
	engine.bitfield = null;
	engine.amInterested = false;
	engine.store = null;
	engine.swarm = swarm;

	if (opts.dht !== false) {
		var table = dht();
		engine.dht = table;
		table.setInfoHash(infoHash);
		if (table.socket) table.socket.on('error', noop);
		table.on('peer', function(addr) {
			var blockedReason = null;
			if (opts.blocklist.length && (blockedReason = isPeerBlocked(addr, opts.blocklist))) {
				engine.emit('blocked-peer', addr, blockedReason);
			} else {
				engine.emit('peer', addr);
				engine.connect(addr);
			}
		});
		table.findPeers(opts.dht || DHT_SIZE); // TODO: be smarter about finding peers
	}

	var ontorrent = function(torrent) {
		engine.store = storage(opts.path, torrent);
		engine.torrent = torrent;
		engine.bitfield = bitfield(torrent.pieces.length);

		var pieceLength = torrent.pieceLength;
		var pieceRemainder = (torrent.length % pieceLength) || pieceLength;

		var pieces = torrent.pieces.map(function(hash, i) {
			return piece(i === torrent.pieces.length-1 ? pieceRemainder : pieceLength);
		});
		var reservations = torrent.pieces.map(function() {
			return [];
		});

		if (opts.tracker !== false) {
			var tr = engine.tracker = new tracker.Client(new Buffer(opts.id), engine.port || DEFAULT_PORT, torrent);

			tr.on('peer', function(addr) {
				engine.connect(addr);
			});

			tr.on('error', noop);

			tr.start();
		}

		torrent.files.forEach(function(file) {
			var offsetPiece = (file.offset / torrent.pieceLength) | 0;
			var endPiece = ((file.offset+file.length-1) / torrent.pieceLength) | 0;

			file.deselect = function() {
				engine.deselect(offsetPiece, endPiece, false);
			};

			file.select = function() {
				engine.select(offsetPiece, endPiece, false);
			};

			file.createReadStream = function(opts) {
				var self = this;
				var stream = fileStream(engine, file, opts);

				engine.select(stream.startPiece, stream.endPiece, true, stream.notify.bind(stream));
				eos(stream, function() {
					engine.deselect(stream.startPiece, stream.endPiece, true);
				});

				return stream;
			};

			engine.files.push(file);
		});

		var oninterestchange = function() {
			var prev = engine.amInterested;
			engine.amInterested = !!engine.selection.length;

			wires.forEach(function(wire) {
				if (engine.amInterested) wire.interested();
				else wire.uninterested();
			});

			if (prev === engine.amInterested) return;
			if (engine.amInterested) engine.emit('interested');
			else engine.emit('uninterested');
		};

		var gc = function() {
			for (var i = 0; i < engine.selection.length; i++) {
				var s = engine.selection[i];
				var oldOffset = s.offset;

				while (!pieces[s.from+s.offset] && s.from+s.offset < s.to) s.offset++;

				if (oldOffset !== s.offset) s.notify();
				if (s.to !== s.from+s.offset) continue;
				if (pieces[s.from+s.offset]) continue;

				engine.selection.splice(i, 1);
				i--; // -1 to offset splice
				s.notify();
				oninterestchange();
			}

			if (!engine.selection.length) engine.emit('idle');
		};

		var onpiececomplete = function(index, buffer) {
			if (!pieces[index]) return;

			pieces[index] = null;
			reservations[index] = null;
			engine.bitfield.set(index, true);

			for (var i = 0; i < wires.length; i++) wires[i].have(index);

			engine.emit('verify', index);
			engine.emit('download', index, buffer);

			engine.store.write(index, buffer);
			gc();
		};

		var onhotswap = opts.hotswap === false ? falsy : function(wire, index) {
			var speed = wire.downloadSpeed();
			if (speed < piece.BLOCK_SIZE) return;
			if (!reservations[index] || !pieces[index]) return;

			var r = reservations[index];
			var minSpeed = Infinity;
			var min;

			for (var i = 0; i < r.length; i++) {
				var other = r[i];
				if (!other || other === wire) continue;

				var otherSpeed = other.downloadSpeed();
				if (otherSpeed >= SPEED_THRESHOLD) continue;
				if (2 * otherSpeed > speed || otherSpeed > minSpeed) continue;

				min = other;
				minSpeed = otherSpeed;
			}

			if (!min) return false;

			for (var i = 0; i < r.length; i++) {
				if (r[i] === min) r[i] = null;
			}

			for (var i = 0; i < min.requests.length; i++) {
				var req = min.requests[i];
				if (req.piece !== index) continue;
				pieces[index].cancel((req.offset / piece.BLOCK_SIZE) | 0);
			}

			engine.emit('hotswap', min, wire, index);
			return true;
		};

		var onupdatetick = function() {
			process.nextTick(onupdate);
		};

		var onrequest = function(wire, index, hotswap) {
			if (!pieces[index]) return false;

			var p = pieces[index];
			var reservation = p.reserve();

			if (reservation === -1 && hotswap && onhotswap(wire, index)) reservation = p.reserve();
			if (reservation === -1) return false;

			var r = reservations[index] || [];
			var offset = p.offset(reservation);
			var size = p.size(reservation);

			var i = r.indexOf(null);
			if (i === -1) i = r.length;
			r[i] = wire;

			wire.request(index, offset, size, function(err, block) {
				if (r[i] === wire) r[i] = null;

				if (p !== pieces[index]) return onupdatetick();

				if (err) {
					p.cancel(reservation);
					onupdatetick();
					return;
				}

				if (!p.set(reservation, block)) return onupdatetick();

				var buffer = p.flush();

				if (sha1(buffer) !== torrent.pieces[index]) {
					pieces[index] = piece(p.length);
					engine.emit('invalid-piece', index, buffer);
					onupdatetick();
					return;
				}

				onpiececomplete(index, buffer);
				onupdatetick();
			});

			return true;
		};

		var onvalidatewire = function(wire) {
			if (wire.requests.length) return;

			for (var i = engine.selection.length-1; i >= 0; i--) {
				var next = engine.selection[i];
				for (var j = next.to; j >= next.from + next.offset; j--) {
					if (!wire.peerPieces[j]) continue;
					if (onrequest(wire, j, false)) return;
				}
			}
		};

		var speedRanker = function(wire) {
			var speed = wire.downloadSpeed() || 1;
			if (speed > SPEED_THRESHOLD) return thruthy;

			var secs = MAX_REQUESTS * piece.BLOCK_SIZE / speed;
			var tries = 10;
			var ptr = 0;

			return function(index) {
				if (!tries || !pieces[index]) return true;

				var missing = pieces[index].missing;
				for (; ptr < wires.length; ptr++) {
					var other = wires[ptr];
					var otherSpeed = other.downloadSpeed();

					if (otherSpeed < speed || !other.peerPieces[index]) continue;
					if (missing -= otherSpeed * secs > 0) continue;

					tries--;
					return false;
				}

				return true;
			};
		};

		var shufflePriority = function(i) {
			var last = i;
			for (var j = i; j < engine.selection.length && engine.selection[j].priority; j++) {
				last = j;
			}
			var tmp = engine.selection[i];
			engine.selection[i] = engine.selection[last];
			engine.selection[last] = tmp;
		};

		var select = function(wire, hotswap) {
			if (wire.requests.length >= MAX_REQUESTS) return true;

			var rank = speedRanker(wire);

			for (var i = 0; i < engine.selection.length; i++) {
				var next = engine.selection[i];
				for (var j = next.from + next.offset; j <= next.to; j++) {
					if (!wire.peerPieces[j] || !rank(j)) continue;
					while (wire.requests.length < MAX_REQUESTS && onrequest(wire, j, critical[j] || hotswap));
					if (wire.requests.length < MAX_REQUESTS) continue;
					if (next.priority) shufflePriority(i);
					return true;
				}
			}

			return false;
		};

		var onupdatewire = function(wire) {
			if (wire.peerChoking) return;
			if (!wire.downloaded) return onvalidatewire(wire);
			select(wire, false) || select(wire, true);
		};

		var onupdate = function() {
			wires.forEach(onupdatewire);
		};

		var onwire = function(wire) {
			wire.setTimeout(opts.timeout || REQUEST_TIMEOUT, function() {
				engine.emit('timeout', wire);
				wire.destroy();
			});

			if (engine.selection.length) wire.interested();

			var timeout = CHOKE_TIMEOUT;
			var id;

			var onchoketimeout = function() {
				if (swarm.queued > 2 * (swarm.size - swarm.wires.length) && wire.amInterested) return wire.destroy();
				id = setTimeout(onchoketimeout, timeout);
			};

			wire.on('close', function() {
				clearTimeout(id);
			});

			wire.on('choke', function() {
				clearTimeout(id);
				id = setTimeout(onchoketimeout, timeout);
			});

			wire.on('unchoke', function() {
				clearTimeout(id);
			});

			wire.on('request', function(index, offset, length, cb) {
				if (pieces[index]) return;
				engine.store.read(index, function(err, buffer) {
					if (err) return cb(err);
					engine.emit('upload', index, offset, length);
					cb(null, buffer.slice(offset, offset+length));
				});
			});

			wire.on('unchoke', onupdate);
			wire.on('bitfield', onupdate);
			wire.on('have', onupdate);

			wire.once('interested', function() {
				wire.unchoke();
			});

			id = setTimeout(onchoketimeout, timeout);
		};

		var onready = function() {
			swarm.on('wire', onwire);
			swarm.wires.forEach(onwire);

			refresh = function() {
				process.nextTick(gc);
				oninterestchange();
				onupdate();
			};

			engine.emit('ready');
			refresh();
		};

		if (opts.verify === false) return onready();

		engine.emit('verifying');

		var loop = function(i) {
			if (i >= torrent.pieces.length) return onready();
			engine.store.read(i, function(_, buf) {
				if (!buf || sha1(buf) !== torrent.pieces[i] || !pieces[i]) return loop(i+1);
				pieces[i] = null;
				engine.bitfield.set(i, true);
				engine.emit('verify', i);
				loop(i+1);
			});
		};

		loop(0);
	};


	swarm.on('wire', function(wire) {
		engine.emit('wire', wire);

		wire.once('extended', function(id, handshake) {
			handshake = bncode.decode(handshake);

			if (id || !handshake.m || handshake.m.ut_metadata === undefined) return;

			var channel = handshake.m.ut_metadata;
			var size = handshake.metadata_size;

			wire.on('extended', function(id, ext) {
				if (id !== EXTENSIONS.m.ut_metadata) return;

				try {
					var delimiter = ext.toString('ascii').indexOf('ee');
					var message = bncode.decode(ext.slice(0, delimiter === -1 ? ext.length : delimiter+2));
					var piece = message.piece;
				} catch (err) {
					return;
				}

				if (!(piece >= 0)) return;
				if (message.msg_type === 2) return;

				if (message.msg_type === 0) {
					if (!metadata) return wire.extended(channel, {msg_type:2, piece:piece});
					var offset = piece * METADATA_BLOCK_SIZE;
					var buf = metadata.slice(offset, offset + METADATA_BLOCK_SIZE);
					wire.extended(channel, Buffer.concat([bncode.encode({msg_type:1, piece:piece}), buf]));
					return;
				}

				if (message.msg_type === 1 && !metadata) {
					metadataPieces[piece] = ext.slice(delimiter+2);
					for (var i = 0; i * METADATA_BLOCK_SIZE < size; i++) {
						if (!metadataPieces[i]) return;
					}

					metadata = Buffer.concat(metadataPieces);

					if (infoHash !== sha1(metadata)) {
						metadataPieces = [];
						metadata = null;
						return;
					}

					var result = {};
					result.info = bncode.decode(metadata);
					result['announce-list'] = [];

					var buf = bncode.encode(result);
					fs.writeFile(torrentPath, buf, function() {
						ontorrent(parseTorrent(buf));
					});
					return;
				}
			});

			if (size > METADATA_MAX_SIZE) return;
			if (!size || metadata) return;

			for (var i = 0; i * METADATA_BLOCK_SIZE < size; i++) {
				if (metadataPieces[i]) continue;
				wire.extended(channel, {msg_type:0, piece:i});
			}
		});

		if (engine.bitfield) wire.bitfield(engine.bitfield);
		if (!wire.peerExtensions.extended) return;

		wire.extended(0, metadata ? {m:{ut_metadata:1}, metadata_size:metadata.length} : {m:{ut_metadata:1}});
	});

	swarm.pause();
	mkdirp(opts.path, function(err) {
		if (err) return engine.emit('error', err);

		if (link.files) {
			metadata = encode(link);
			swarm.resume();
			if (metadata) ontorrent(link);
			return;
		}

		fs.readFile(torrentPath, function(_, buf) {
			swarm.resume();
			if (!buf) return;
			var torrent = parseTorrent(buf);
			metadata = encode(torrent);
			if (metadata) ontorrent(torrent);
		});
	});

	engine.critical = function(piece, width) {
		for (var i = 0; i < (width || 1); i++) critical[piece+i] = true;
	};

	engine.select = function(from, to, priority, notify) {
		engine.selection.push({
			from:from,
			to:to,
			offset:0,
			priority: toNumber(priority),
			notify: notify || noop
		});

		engine.selection.sort(function(a, b) {
			return b.priority - a.priority;
		});

		refresh();
	};

	engine.deselect = function(from, to, priority) {
		for (var i = 0; i < engine.selection.length; i++) {
			var s = engine.selection[i];
			if (s.from !== from || s.to !== to) continue;
			if (s.priority !== toNumber(priority)) continue;
			engine.selection.splice(i, 1);
			i--;
			break;
		}

		refresh();
	};

	engine.connect = function(addr) {
		swarm.add(addr);
	};

	engine.disconnect = function(addr) {
		swarm.remove(addr);
	};

	engine.remove = function(cb) {
		rimraf(engine.path, cb || noop);
	};

	engine.destroy = function(cb) {
		swarm.destroy();
		if (engine.tracker) engine.tracker.stop();
		if (engine.dht) engine.dht.close();
		if (engine.store) {
			engine.store.close(cb);
		} else if (cb) {
			process.nextTick(cb);
		}
	};

	engine.listen = function(port, cb) {
		if (typeof port === 'function') return that.listen(0, port);
		engine.port = port || DEFAULT_PORT;
		swarm.listen(engine.port, cb);
	};

	return engine;
};

module.exports = torrentStream;
