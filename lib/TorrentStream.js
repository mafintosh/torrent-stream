var path          = require('path');
var fs            = require('fs');
var os            = require('os');
var util          = require('util');
var events        = require('events');

var hat           = require('hat');
var bitfield      = require('bitfield');
var bncode        = require('bncode');
var crypto        = require('crypto');
var mkdirp        = require('mkdirp');
var rimraf        = require('rimraf');
var ip            = require('ip');
var dht           = require('bittorrent-dht');
var tracker       = require('bittorrent-tracker');

var readTorrent   = require('read-torrent');
var parseTorrent  = require('parse-torrent');
var peerWireSwarm = require('peer-wire-swarm');
var endOfStream   = require('end-of-stream');

var encode        = require('./utils.js').encode;
var noop          = require('./utils.js').noop;
var sha1          = require('./utils.js').sha1;
var fileStream    = require('./FileStream.js');
var storage       = require('./Storage.js');
var piece         = require('./Piece.js');

// CONSTANTS
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

// Helpers
var noop = function() {};
var sha1 = function(data) { return crypto.createHash('sha1').update(data).digest('hex'); };

/* @Constructor */
var TorrentStream = module.exports = function TorrentStream (torrent, options) {
	if (this instanceof TorrentStream === false) return new TorrentStream (torrent, options);
	var t = this; events.EventEmitter.call(this);

	// Default options
	t.options = options = options || {};
	if (!t.options.id)        t.options.id   = '-TS0008-'+hat(48);
	if (!t.options.name)      t.options.name = 'torrent-stream';
	if (!t.options.tmp)       t.options.tmp  = TMP;
	if (!t.options.path)      t.options.path = path.join(t.options.tmp, t.options.name);
	if (!t.options.blocklist) t.options.blocklist = [];

	// Get torrent information from link, download if needed.
	if (!!torrent && !!torrent.infoHash) {
		t._torrent = torrent;
		process.nextTick(t._onTorrent().bind(t)) // Ensure Async
	} else {
		readTorrent(torrent, function(err, torrent) {
			if (err) return t.error(err);
			if (!torrent.infoHash) return t.error(new Error('You must pass a valid torrent or magnet link'));
			t._torrent = torrent;
			t._onTorrent();
		});
	}

	// Internals
	t._files          = [];
	t._selection      = [];
	t._critical       = [];
	t._amInterested   = false;

	t._torrentPath    = null;
	t._metadata       = null;
	t._metadataPieces = [];

	// Internal References place-holders
	t._swarm          = null;
	t._tracker        = null;
	t._dht            = null;
	t._storage        = null;
	t._bitfield       = null;

};
util.inherits(TorrentStream, events.EventEmitter);

/* Called when we got a valid torrent file / magnet */
TorrentStream.prototype._onTorrent = function() {
	var t = this;

	// Generate Torrent Path
	t._torrentPath = path.join(t.options.path, t._torrent.infoHash, 'cache.torrent');

	// Initialize Swarm
	t._swarm = peerWireSwarm(
		t._torrent.infoHash, 
		t.options.id, 
		{ size: t.options.connections || t.options.size }
	);

	// Initialize DHT
	if (t.options.dht !== false) {
		t._dht = dht();
		t._dht.setInfoHash(t._torrent.infoHash);
		if (t._dht.socket) t._dht.socket.on('error', noop);
		t._dht.on('peer', function(addr) {
			var blockedReason = null;
			if (t.options.blocklist.length && (blockedReason = t.isPeerBlocked(addr))) {
				t.emit('blocked-peer', addr, blockedReason);
			} else {
				t.emit('peer', addr);
				t.connect(addr);
			}
		});
		t._dht.findPeers(t.options.dht || DHT_SIZE); // TODO: be smarter about finding peers
	}

	// Create torrent cache dir
	t._swarm.pause(); // Pause Swarm until we read cache? IDK
	mkdirp(path.dirname(t._torrentPath), function(err) {
		if (err) return t.emit('error', err);
		// Check if torrent has all the info we need
		if (t._torrent.files) {
			t._metadata = encode(t._torrent);
			t._swarm.resume();
			if (t._metadata) t._onTorrentMetadata();
			return;
		}
		// Try to read torrent metadata from cache
		readTorrent(t._torrentPath, function(err, torrent) {
			t._swarm.resume();
			if (!torrent) return;
			t._torrent = torrent;
			t._metadata = encode(t._torrent);
			if (t._metadata) t._onTorrentMetadata();
		})
	});

	t.emit('init');

	// FOLLOWING CODE IS TO FIND TORRENT METADATA - TODO: Isolate in its own function.
	t._swarm.on('wire', function(wire) {
		t.emit('wire', wire);

		wire.once('extended', function(id, handshake) {
			handshake = bncode.decode(handshake);

			if (id || !handshake.m || handshake.m.ut_metadata === undefined) return;

			var channel = handshake.m.ut_metadata;
			var size    = handshake.metadata_size;

			wire.on('extended', function(id, ext) {
				if (id !== EXTENSIONS.m.ut_metadata) return;

				try {
					var delimiter = ext.toString('ascii').indexOf('ee');
					var message   = bncode.decode(ext.slice(0, delimiter === -1 ? ext.length : delimiter+2));
					var piece     = message.piece;
				} catch (err) {
					return;
				}

				if (!(piece >= 0)) return;
				if (message.msg_type === 2) return;

				if (message.msg_type === 0) {
					if (!t._metadata) return wire.extended(channel, {msg_type:2, piece:piece});
					var offset = piece * METADATA_BLOCK_SIZE;
					var buf = t._metadata.slice(offset, offset + METADATA_BLOCK_SIZE);
					wire.extended(channel, Buffer.concat([bncode.encode({msg_type:1, piece:piece}), buf]));
					return;
				}

				if (message.msg_type === 1 && !t._metadata) {
					t._metadataPieces[piece] = ext.slice(delimiter+2);
					for (var i = 0; i * METADATA_BLOCK_SIZE < size; i++) {
						if (!t._metadataPieces[i]) return;
					}

					t._metadata = Buffer.concat(t._metadataPieces);

					if (t._torrent.infoHash !== sha1(t._metadata)) {
						t._metadataPieces = [];
						t._metadata = null;
						return;
					}

					var result = {};
					result.info = bncode.decode(t._metadata);
					result['announce-list'] = [];

					var buf = bncode.encode(result);
					fs.writeFile(t._torrentPath, buf, function() {
						t._torrent = parseTorrent(buf);
						t._onTorrentMetadata();
					});
					return;
				}
			});

			if (size > METADATA_MAX_SIZE) return;
			if (!size || t._metadata) return;

			for (var i = 0; i * METADATA_BLOCK_SIZE < size; i++) {
				if (t._metadataPieces[i]) continue;
				wire.extended(channel, {msg_type:0, piece:i});
			}
		});

		if (t._bitfield) wire.bitfield(t._bitfield);
		if (!wire.peerExtensions.extended) return;

		wire.extended(0, t._metadata ? {m:{ut_metadata:1}, metadata_size:t._metadata.length} : {m:{ut_metadata:1}});
	});
}

/* Called when we got the torrent metadata with peers */
TorrentStream.prototype._onTorrentMetadata = function() {
	var t = this;

	t.emit('torrent-metadata');

	// Initialize Storage
	t._storage = storage(path.dirname(t._torrentPath), t._torrent);

	// Initialize Bitfield
	t._bitfield = bitfield(t._torrent.pieces.length);

	// Initilize Torrent Pieces
	var pieceReminder = (t._torrent.length % t._torrent.pieceLength) || t._torrent.pieceLength;
	t.pieces = t._torrent.pieces.map(function(hash, i) {
		return piece(i === t._torrent.pieces.length-1 ? pieceReminder : t._torrent.pieceLength);
	});

	t.reservations = t._torrent.pieces.map(function() { return []; });

	// Initialize Tracker
	if (t.options.tracker !== false) {
		t._tracker = new tracker.Client(
			new Buffer(t.options.id),
			t.port || DEFAULT_PORT,
			t._torrent
		);

		t._tracker.on('peer', function(addr) {
			// t.emit('peer', addr);
			t.connect(addr);
		});

		t._tracker.on('error', noop);

		t._tracker.start();
	}

	// Handle Torrent Files
	t._torrent.files.forEach(function(file) {
		var offsetPiece = (file.offset                 / t._torrent.pieceLength) | 0;
		var endPiece    = ((file.offset+file.length-1) / t._torrent.pieceLength) | 0;

		// Extend API
		file.deselect = function() { t.deselect( offsetPiece, endPiece, false); };
		file.select   = function() { t.select(   offsetPiece, endPiece, false); };
		file.createReadStream = function(options) {
			var stream = fileStream(t, file, options);
			t.select(stream.startPiece, stream.endPiece, true, stream.notify.bind(stream));
			endOfStream(stream, function() {
				t.deselect(stream.startPiece, stream.endPiece, true);
			});
			return stream;
		};

		t._files.push(file);
	})

	// Verify Torrent
	if (t.options.verify === true) return t._verify();
	else return t._onReady();
}


TorrentStream.prototype._verify = function() {
	var t = this;
	t.emit('verifying');
	var loop = function(i) {
		if (i >= t._torrent.pieces.length) return t._onReady();
		t._storage.read(i, function(_, buf) {
			if (!buf || sha1(buf) !== t._torrent.pieces[i] || !t.pieces[i]) return loop(i+1);
			t.pieces[i] = null;
			t._bitfield.set(i, true);
			t.emit('verify', i);
			loop(i+1);
		});
	};
	loop(0);	
}

/* Called when we are Ready! */
TorrentStream.prototype._onReady = function() {
	var t = this;
	t._swarm.on('wire',    t._onWire.bind(t));
	t._swarm.wires.forEach(t._onWire.bind(t));
	t._isReady = true;
	t.emit('ready');
	t._refresh();
}

/* Handle new Wires (once Ready) */
TorrentStream.prototype._onWire = function (wire) {
	var t = this;

	// Create timeout timer
	wire.setTimeout(t.options.timeout || REQUEST_TIMEOUT, function() {
		t.emit('timeout', wire);
		wire.destroy();
	});

	if (t._selection.length) wire.interested();

	var timeout = CHOKE_TIMEOUT;
	var id;

	var _onChokeTimeout = function() {
		if (t._swarm.queued > 2 * (t._swarm.size - t._swarm.wires.length) && wire.amInterested) return wire.destroy();
		id = setTimeout(_onChokeTimeout, timeout);
	};

	wire.on('close', function() { clearTimeout(id);	});

	wire.on('choke', function() {
		clearTimeout(id);
		id = setTimeout(_onChokeTimeout, timeout);
	});

	wire.on('unchoke', function() { clearTimeout(id); });

	wire.on('request', function(index, offset, length, cb) {
		if (t.pieces[index]) return;
		t._storage.read(index, function(err, buffer) {
			if (err) return cb(err);
			t.emit('upload', index, offset, length);
			cb(null, buffer.slice(offset, offset+length));
		});
	});

	wire.on('unchoke',  t._onUpdate.bind(t));
	wire.on('bitfield', t._onUpdate.bind(t));
	wire.on('have',     t._onUpdate.bind(t));

	wire.once('interested', function() { wire.unchoke(); });

	id = setTimeout(_onChokeTimeout, timeout);
}

/* Updates all wires */
TorrentStream.prototype._onUpdate = function() {
	this.swarm.wires.forEach(this._onUpdateWire, this);
}

/* Defered/Async-style update  */
TorrentStream.prototype._onUpdateNextTick = function() {
	process.nextTick(this._onUpdate.bind(this));
}

/* Called by onUpdate */
TorrentStream.prototype._onUpdateWire = function (wire) {
	var t = this;
	if (wire.peerChoking) return;
	if (!wire.downloaded) return t._onValidateWire(wire);
	t._select(wire, false) || t._select(wire, true);
}

/* Called by onUpdateWire */
TorrentStream.prototype._onValidateWire = function(wire) {
	var t = this;
	if (wire.requests.length) return;
	for (var i = t._selection.length-1; i >= 0; i--) {
		var next = t._selection[i];
		for (var j = next.to; j >= next.from + next.offset; j--) {
			if (!wire.peerPieces[j]) continue;
			if (t._onRequest(wire, j, false)) return;
		}
	}
};

/* Called by onUpdateWire */
TorrentStream.prototype._select = function (wire, hotswap) {
	var t = this;
	if (wire.requests.length >= MAX_REQUESTS) return true;
	var rank = t._speedRanker(wire);
	for (var i = 0; i < t._selection.length; i++) {
		var next = t._selection[i];
		for (var j = next.from + next.offset; j <= next.to; j++) {
			if (!wire.peerPieces[j] || !rank(j)) continue;
			while (wire.requests.length < MAX_REQUESTS && t._onRequest(wire, j, t._critical[j] || hotswap));
			if (wire.requests.length >= MAX_REQUESTS) return true;
		}
	}
}

/* Called by _select */
TorrentStream.prototype._speedRanker = function (wire) {
	var t = this;
	var speed = wire.downloadSpeed() || 1;
	if (speed > SPEED_THRESHOLD) return function() { return true; };

	var secs = MAX_REQUESTS * piece.BLOCK_SIZE / speed;
	var tries = 10;
	var ptr = 0;

	return function(index) {
		if (!tries || !t.pieces[index]) return true;
		var missing = t.pieces[index].missing;
		for (; ptr < t._swarm.wires.length; ptr++) {
			var other = t._swarm.wires[ptr];
			var otherSpeed = other.downloadSpeed();
			if (otherSpeed < speed || !other.peerPieces[index]) continue;
			if (missing -= otherSpeed * secs > 0) continue;
			tries--;
			return false;
		}
		return true;
	};	
}

/* Called on _select and _onValidateWire  */
TorrentStream.prototype._onRequest = function (wire, index, hotswap) {
	var t = this;
	if (!t.pieces[index]) return false;

	var p = t.pieces[index];
	var reservation = p.reserve();

	if (reservation === -1 && hotswap && t._onHotSwap(wire, index)) reservation = p.reserve();
	if (reservation === -1) return false;

	var r = t.reservations[index] || [];
	var offset = p.offset(reservation);
	var size = p.size(reservation);

	var i = r.indexOf(null);
	if (i === -1) i = r.length;
	r[i] = wire;

	wire.request(index, offset, size, function(err, block) {
		if (r[i] === wire) r[i] = null;
		if (p !== t.pieces[index]) return t._onUpdateNextTick();

		if (err) {
			p.cancel(reservation);
			return t._onUpdateNextTick();
		}

		if (!p.set(reservation, block)) return t._onUpdateNextTick();

		var buffer = p.flush();

		if (sha1(buffer) !== t._torrent.pieces[index]) {
			t.pieces[index] = t.piece(p.length);
			t.emit('invalid-piece', index, buffer);
			return t._onUpdateNextTick();
		}

		t._onPieceComplete(index, buffer);
		t._onUpdateNextTick();
	});

	return true;
}

/* Called on _onRequest */
TorrentStream.prototype._onHotSwap = function (wire, index) {
	var t = this;
	if (t.options.hotswap === false) return false;

	var speed = wire.downloadSpeed();
	if (speed < piece.BLOCK_SIZE) return;
	if (!t.reservations[index] || !t.pieces[index]) return;

	var r = t.reservations[index];
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
		t.pieces[index].cancel((req.offset / piece.BLOCK_SIZE) | 0);
	}

	t.emit('hotswap', min, wire, index);
	return true;
}

/* Called when _onRequest is completed */
TorrentStream.prototype._onPieceComplete = function (index, buffer) {
	var t = this;
	if (!t.pieces[index]) return;

	t.pieces[index]       = null;
	t.reservations[index] = null;
	t._bitfield.set(index, true);

	for (var i = 0; i < t._swarm.wires.length; i++) 
		t._swarm.wires[i].have(index);

	t.emit('verify', index);
	t.emit('download', index, buffer);

	t._storage.write(index, buffer);
	t._gc();
}

TorrentStream.prototype._refresh = function() {
	var t = this;
	if (!this._isReady) return;
	process.nextTick(this._gc.bind(t));
	this._onInterestChange();
	this._onUpdate();
}

/* Called when interested might have changed 
 * This will refresh interested status. */
TorrentStream.prototype._onInterestChange = function() {
	var t = this;

	var prev = t._amInterested;
	t._amInterested = !!t._selection.length;

	t._swarm.wires.forEach(function(wire) {
		if (t._amInterested) wire.interested();
		else wire.uninterested();
	})

	if (prev === t._amInterested) return;

	if (t._amInterested) t.emit('interested')
	else t.emit('uninterested');
}

/* It's a garbage collector function, called by onPieceComplete and _refresh */
TorrentStream.prototype._gc = function() {
	var t = this;

	for (var i = 0; i < t._selection.length; i++) {
		var s = t._selection[i];
		var oldOffset = s.offset;

		while (!t.pieces[s.from+s.offset] && s.from+s.offset < s.to) s.offset++;

		if (oldOffset !== s.offset) s.notify();
		if (s.to !== s.from+s.offset) continue;
		if (t.pieces[s.from+s.offset]) continue;

		t._selection.splice(i, 1);
		i--; // -1 to offset splice
		s.notify();
		t._onInterestChange();
	}
	if (!t._selection.length) t.emit('idle');
}

/* PUBLIC API */

/* Expose internal properties as Read Only */
Object.defineProperty(TorrentStream.prototype, 'files', { get: function () { return this._files; } });
Object.defineProperty(TorrentStream.prototype, 'swarm', { get: function () { return this._swarm; } });

/* Check if peer is in the blocklist.
 * Will check on options.blocklist by default. */
TorrentStream.prototype.isPeerBlocked = function (addr, blocklist) {
	var blockedReason = null;
	if (!blocklist) blocklist = this.options.blocklist;
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

/* Internally used by FileStream */
TorrentStream.prototype.critical = function (piece, width) {
	var t = this;
	for (var i = 0; i < (width || 1); i++) t._critical[piece+i] = true;
};

/* Internally used by file.select() */
TorrentStream.prototype.select = function (from, to, priority, notify) {
	var t = this;
	priority = priority === true ? 1 : (priority || 0);
	t._selection.push({
		from:from,
		to:to,
		offset:0,
		priority: priority,
		notify: notify || noop
	});
	t._selection.sort(function(a, b) {
		return b.priority - a.priority;
	});
	t._refresh();
};

/* Internally used by file.deselect() */
TorrentStream.prototype.deselect = function (from, to, priority) {
	var t = this;
	priority = priority === true ? 1 : (priority || 0);
	for (var i = 0; i < t._selection.length; i++) {
		var s = t._selection[i];
		if (s.from !== from || s.to !== to) continue;
		if (s.priority !== priority) continue;
		t._selection.splice(i, 1);
		i--;
		break;
	}
	t._refresh();
};

/* Connect to a peer manually. */
TorrentStream.prototype.connect = function (addr) {
	var t = this;
	if (!t._swarm) return t.once('init', function() { t.connect(addr) });
	this._swarm.add(addr);
};

/* Disconnect from a peer manually. */
TorrentStream.prototype.disconnect = function (addr) {
	if (!this._swarm) return;
	this._swarm.remove(addr);
};

/* Completely remove all saved data for this torrent */
TorrentStream.prototype.remove = function (cb) {
	if (!this._torrentPath) return process.nextTick(cb || noop);
	rimraf(path.dirname(this._torrentPath), cb || noop);
};

/* Destroy the engine. Destroys all connections to peers. */
TorrentStream.prototype.destroy = function (cb) {
	var t = this;
	if (t._swarm)   t._swarm.destroy();
	if (t._tracker) t._tracker.stop();
	if (t._dht)     t._dht.close();
	if (t._storage) {
		t._storage.close(cb);
	} else if (cb) {
		process.nextTick(cb);
	}
};

/* Listen for incoming peers on the specified port. */
TorrentStream.prototype.listen = function (port, cb) {
	var t = this;
	if (!t._swarm) return t.once('init', function() { t.listen(port, cb) });
	if (typeof port === 'function') return t._swarm.listen(0, port);
	t.port = port || DEFAULT_PORT;
	t._swarm.listen(t.port, cb);
};
