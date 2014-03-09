var peerWireSwarm = require('peer-wire-swarm');
var hat = require('hat');
var events = require('events');
var bitfield = require('bitfield');
var eos = require('end-of-stream');
var crypto = require('crypto');
var path = require('path');
var os = require('os');
var piece = require('./piece');
var storage = require('./storage');

var noop = function() {};

var toNumber = function(val) {
	return val === true ? 1 : (val || 0);
};

var bufferify = function(store) {
	var that = {};
	var mem = [];

	that.write = function(index, buffer, cb) {
		mem[index] = buffer;
		store.write(index, buffer, function(err) {
			mem[index] = null;
			if (cb) cb(err);
		});
	};

	that.read = function(index, cb) {
		if (mem[index]) return cb(null, mem[index]);
		store.read(index, cb);
	};

	return that;
};

var engine = function(torrent, opts) {
	if (!opts) opts = {};
	if (!opts.path) opts.path = path.join(os.tmpDir(), 'torrent-stream');
	if (!opts.id) opts.id = '-PF0007-'+hat(48);

	var that = new events.EventEmitter();
	var swarm = peerWireSwarm(torrent.infoHash, opts.id, opts);
	var store = bufferify(opts.storage || storage(opts.path));

	var pieceLength = torrent.pieceLength;
	var pieceRemainder = (torrent.length % pieceLength) || pieceLength;

	var bits = bitfield(torrent.pieces.length);
	var pieces = torrent.pieces.map(function(hash, i) {
		return piece(i === torrent.pieces.length-1 ? pieceRemainder : pieceLength);
	});

	var selection = [];
	var critical = [];

	var verify = function(index, buffer) {
		return crypto.createHash('sha1').update(buffer).digest('hex') === torrent.pieces[index];
	};

	var gc = function() {
		for (var i = 0; i < selection.length; i++) {
			var s = selection[i];
			var oldOffset = s.offset;

			while (!pieces[s.from+s.offset] && s.from+s.offset < s.to) s.offset++;

			if (oldOffset !== s.offset) s.notify();
			if (s.to !== s.from+s.offset) continue;
			if (pieces[s.from+s.offset]) continue;

			selection.splice(i, 1);
			i--; // -1 to offset splice
			s.notify();
		}
	};

	var onpiececomplete = function(index, buffer) {
		pieces[index] = null;
		bits.set(index, true);

		for (var i = 0; i < swarm.wires.length; i++) swarm.wires[i].have(index);

		that.emit('verify', index);
		that.emit('download', index, buffer);

		store.write(index, buffer);
		gc();
	};

	var onrequest = function(wire, index) {
		if (!pieces[index]) return false;

		var p = pieces[index];
		var reservation = p.reserve();
		if (reservation === -1) return false;

		var offset = p.offset(reservation);
		var size = p.size(reservation);

		wire.request(index, offset, size, function(err, block) {
			if (p !== pieces[index]) return onupdate();

			if (err) {
				p.cancel(reservation);
				onupdate();
				return;
			}

			if (!p.set(reservation, block)) return onupdate();

			var buffer = p.flush();

			if (!verify(index, buffer)) {
				pieces[index] = piece(p.length);
				that.emit('invalid-piece', index, buffer);
				onupdate();
				return;
			}

			onpiececomplete(index, buffer);
			onupdate();
		});

		return true;
	};

	var onvalidatewire = function(wire) {
		if (wire.requests.length) return;

		for (var i = selection.length-1; i >= 0; i--) {
			var next = selection[i];
			for (var j = next.to; j >= next.from + next.offset; j--) {
				if (!wire.peerPieces[j]) continue;
				if (onrequest(wire, j)) return;
			}
		}
	};

	var onupdatewire = function(wire) {
		if (wire.peerChoking) return;
		if (wire.requests.length >= 5) return;

		if (!wire.downloaded) return onvalidatewire(wire);

		for (var i = 0; i < selection.length; i++) {
			var next = selection[i];
			for (var j = next.from + next.offset; j <= next.to; j++) {
				if (!wire.peerPieces[j]) continue;
				while (wire.requests.length < 5 && onrequest(wire, j));
				if (wire.requests.length >= 5) return;
			}
		}
	};

	var onupdate = function() {
		swarm.wires.forEach(onupdatewire);
	};

	swarm.on('wire', function(wire) {
		wire.setTimeout(opts.timeout || 5000, function() {
			that.emit('timeout', wire);
			wire.destroy();
		});

		wire.bitfield(bits);
		wire.unchoke();

		wire.on('request', function(index, offset, length, cb) {
			if (pieces[index]) return;
			store.read(index, function(err, buffer) {
				if (err) return cb(err);
				that.emit('upload', index, offset, length);
				cb(null, buffer.slice(offset, length));
			});
		});

		wire.on('unchoke', onupdate);
		wire.on('bitfield', onupdate);
		wire.on('have', onupdate);

		that.emit('wire', wire);
	});

	that.torrent = torrent;
	that.selection = selection;
	that.wires = swarm.wires;
	that.store = store;

	that.connect = function(addr) {
		swarm.add(addr);
	};

	that.disconnect = function(addr) {
		swarm.remove(addr);
	};

	that.critical = function(piece) {
		critical[piece] = true;
	};

	that.select = function(from, to, priority, notify) {
		selection.push({
			from:from,
			to:to,
			offset:0,
			priority: toNumber(priority),
			notify: notify || noop
		});

		selection.sort(function(a, b) {
			return b.priority - a.priority;
		});

		process.nextTick(gc);
		onupdate();
	};

	that.deselect = function(from, to, priority) {
		for (var i = 0; i < selection.length; i++) {
			var s = selection[i];
			if (s.from !== from || s.to !== to) continue;
			if (s.priority !== toNumber(priority)) continue;
			selection.splice(i, 1);
			i--;
			break;
		}

		onupdate();
	};

	that.read = function(i, cb) {
		store.read(i, cb);
	};

	that.verified = function(i) {
		return !pieces[i];
	};

	that.verify = function(cb) {
		swarm.pause();

		var done = function() {
			swarm.resume();
			gc();
			if (cb) cb();
		};

		var loop = function(i) {
			if (i >= torrent.pieces.length) return done();

			store.read(i, function(err, buffer) {
				if (!buffer) return loop(i+1);
				if (!verify(i, buffer)) return loop(i+1);

				pieces[i] = null;
				bits.set(i, true);
				that.emit('verify', i);

				loop(i+1);
			});
		};

		loop(0);
	};

	return that;
};

module.exports = engine;