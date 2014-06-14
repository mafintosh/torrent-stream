var magnet = require('magnet-uri');
var hat = require('hat');
var pws = require('peer-wire-swarm');
var bncode = require('bncode');
var parseTorrent = require('parse-torrent');
var mkdirp = require('mkdirp');
var events = require('events');
var path = require('path');
var fs = require('fs');
var os = require('os');
var eos = require('end-of-stream');

var peerDiscovery = require('./lib/peer-discovery');
var blocklist = require('./lib/blocklist');
var exchangeMetadata = require('./lib/exchange-metadata');
var fileStream = require('./lib/file-stream');
var rechoke = require('./lib/rechoke');
var client = require('./lib/torrent-client');

var DEFAULT_PORT = 6881;
var RECHOKE_INTERVAL = 10000;

var TMP = fs.existsSync('/tmp') ? '/tmp' : os.tmpDir();

var noop = function() {};

var toNumber = function(val) {
	return val === true ? 1 : (val || 0);
};

var torrentStream = function(link, opts, cb) {
	if (typeof opts === 'function') return torrentStream(link, null, opts);

	var metadata = null;

	if (Buffer.isBuffer(link)) {
		metadata = bncode.encode(bncode.decode(link).info);
		link = parseTorrent(link);
	} else if (typeof link === 'string') {
		link = magnet(link);
	} else {
		link = null;
	}

	if (!link || !link.infoHash) throw new Error('You must pass a valid torrent or magnet link');

	var infoHash = link.infoHash;

	if (!opts) opts = {};
	if (!opts.id) opts.id = '-TS0008-'+hat(48);
	if (!opts.tmp) opts.tmp = TMP;
	if (!opts.name) opts.name = 'torrent-stream';

	var usingTmp = false;
	var destroyed = false;

	if (!opts.path) {
		usingTmp = true;
		opts.path = path.join(opts.tmp, opts.name, infoHash);
	}

	var engine = new events.EventEmitter();
	var swarm = pws(infoHash, opts.id, { size: (opts.connections || opts.size), speed: 10 });
	var torrentPath = path.join(opts.tmp, opts.name, infoHash + '.torrent');

	if (cb) engine.on('ready', cb.bind(null, engine));

	var wires = swarm.wires;
	var critical = [];

	var rechokeSlots = (opts.uploads === false || opts.uploads === 0) ? 0 : (+opts.uploads || 10);
	var rechokeIntervalId;

	engine.infoHash = infoHash;
	engine.metadata = metadata;
	engine.path = opts.path;
	engine.files = [];
	engine.selection = [];
	engine.torrent = null;
	engine.bitfield = null;
	engine.amInterested = false;
	engine.store = null;
	engine.swarm = swarm;

	var discovery = peerDiscovery(opts);
	var blocked = blocklist(opts.blocklist);

	discovery.on('peer', function(addr) {
		if (blocked.contains(addr.split(':')[0])) {
			engine.emit('blocked-peer', addr);
		} else {
			engine.emit('peer', addr);
			engine.connect(addr);
		}
	});

	engine.once('ready', function() {
		rechokeIntervalId = setInterval(rechoke(wires, rechokeSlots), RECHOKE_INTERVAL);
	});

	var ontorrent = function(torrent) {
		client(engine, torrent, critical, opts);

		discovery.setTorrent(torrent);

		engine.files = torrent.files.map(function(file) {
			file = Object.create(file);
			var offsetPiece = (file.offset / torrent.pieceLength) | 0;
			var endPiece = ((file.offset+file.length-1) / torrent.pieceLength) | 0;

			file.deselect = function() {
				engine.deselect(offsetPiece, endPiece, false);
			};

			file.select = function() {
				engine.select(offsetPiece, endPiece, false);
			};

			file.createReadStream = function(opts) {
				var stream = fileStream(engine, file, opts);

				engine.select(stream.startPiece, stream.endPiece, true, stream.notify.bind(stream));
				eos(stream, function() {
					engine.deselect(stream.startPiece, stream.endPiece, true);
				});

				return stream;
			};

			return file;
		});
	};

	var exchange = exchangeMetadata(engine, function(metadata) {
		var buf = bncode.encode({
			info: bncode.decode(metadata),
			'announce-list': []
		});

		ontorrent(parseTorrent(buf));

		mkdirp(path.dirname(torrentPath), function(err) {
			if (err) return engine.emit('error', err);
			fs.writeFile(torrentPath, buf, function(err) {
				if (err) engine.emit('error', err);
			});
		});
	});

	swarm.on('wire', function(wire) {
		engine.emit('wire', wire);
		exchange(wire);
		if (engine.bitfield) wire.bitfield(engine.bitfield);
	});

	swarm.pause();

	if (link.files) {
		swarm.resume();
		ontorrent(link);
	} else {
		fs.readFile(torrentPath, function(_, buf) {
			if (destroyed) return;
			swarm.resume();

			// We know only infoHash here, not full infoDictionary.
			// But infoHash is enough to connect to trackers and get peers.
			if (!buf) return discovery.setTorrent(link);

			var torrent = parseTorrent(buf);

			// Bad cache file - fetch it again
			if (torrent.infoHash !== link.infoHash) return discovery.setTorrent(link);

			engine.metadata = bncode.encode(bncode.decode(buf).info);
			ontorrent(torrent);
		});
	}

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

		engine.emit('refresh');
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

		engine.emit('refresh');
	};

	engine.connect = function(addr) {
		swarm.add(addr);
	};

	engine.disconnect = function(addr) {
		swarm.remove(addr);
	};

	engine.block = function(addr) {
		blocked.add(addr.split(':')[0]);
		engine.disconnect(addr);
		engine.emit('blocking', addr);
	};

	var removeTorrent = function(cb) {
		fs.unlink(torrentPath, function(err) {
			if (err) return cb(err);
			fs.rmdir(path.dirname(torrentPath), function(err) {
				if (err && err.code !== 'ENOTEMPTY') return cb(err);
				cb();
			});
		});
	};

	var removeTmp = function(cb) {
		if (!usingTmp) return removeTorrent(cb);
		fs.rmdir(opts.path, function(err) {
			if (err) return cb(err);
			removeTorrent(cb);
		});
	};

	engine.remove = function(keepPieces, cb) {
		if (typeof keepPieces === 'function') {
			cb = keepPieces;
			keepPieces = false;
		}

		if (keepPieces || !engine.store) return removeTmp(cb);

		engine.store.remove(function(err) {
			if (err) return cb(err);
			removeTmp(cb);
		});
	};

	engine.destroy = function(cb) {
		destroyed = true;
		swarm.destroy();
		clearInterval(rechokeIntervalId);
		discovery.stop();
		if (engine.store) {
			engine.store.close(cb);
		} else if (cb) {
			process.nextTick(cb);
		}
	};

	engine.listen = function(port, cb) {
		if (typeof port === 'function') return engine.listen(0, port);
		engine.port = port || DEFAULT_PORT;
		swarm.listen(engine.port, cb);
		discovery.updatePort(engine.port);
	};

	return engine;
};

module.exports = torrentStream;
