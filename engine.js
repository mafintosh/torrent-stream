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

var thruthy = function() {
	return true;
};

var falsy = function() {
	return false;
};

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
	if (!opts.path) opts.path = path.join(opts.tmp || os.tmpDir(), 'peerflix', torrent.infoHash);
	if (!opts.id) opts.id = '-PF0007-'+hat(48);

	var that = new events.EventEmitter();
	var swarm = peerWireSwarm(torrent.infoHash, opts.id, opts);
	var store = bufferify(opts.storage || storage(opts.path));

	var wires = swarm.wires;
	var pieceLength = torrent.pieceLength;
	var pieceRemainder = (torrent.length % pieceLength) || pieceLength;

	var bits = bitfield(torrent.pieces.length);
	var pieces = torrent.pieces.map(function(hash, i) {
		return piece(i === torrent.pieces.length-1 ? pieceRemainder : pieceLength);
	});

	var reservations = torrent.pieces.map(function() {
		return [];
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
		reservations[index] = null;

		bits.set(index, true);

		for (var i = 0; i < wires.length; i++) wires[i].have(index);

		that.emit('verify', index);
		that.emit('download', index, buffer);

		store.write(index, buffer);
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

		that.emit('hotswap', min, wire, index);
		return true;
	};

	var onupdatetick = function() {
		process.nextTick(onupdate);
	};

	var onrequest = function(wire, index) {
		if (!pieces[index]) return false;

		var p = pieces[index];
		var reservation = p.reserve();

		if (reservation === -1 && critical[index] && onhotswap(wire, index)) reservation = p.reserve();
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

			if (!verify(index, buffer)) {
				pieces[index] = piece(p.length);
				that.emit('invalid-piece', index, buffer);
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

		for (var i = selection.length-1; i >= 0; i--) {
			var next = selection[i];
			for (var j = next.to; j >= next.from + next.offset; j--) {
				if (!wire.peerPieces[j]) continue;
				if (onrequest(wire, j)) return;
			}
		}
	};

	var speedRanker = function(wire) {
		var speed = wire.downloadSpeed() || 1;
		if (speed > piece.BLOCK_SIZE) return thruthy;

		var secs = 5 * piece.BLOCK_SIZE / speed;
		var tries = 5;
		var ptr = 0;

		return function(index) {
			if (!tries || !pieces[index]) return true;

			var missing = pieces[index].missing;
			for (; ptr < wires.length; ptr++) {
				var other = wires[ptr];
				var speed = other.downloadSpeed();

				if (speed < piece.BLOCK_SIZE || !other.peerPieces[index]) continue;
				if (missing -= speed * secs > 0) continue;

				tries--;
				return false;
			}

			return true;
		};
	};

	var onupdatewire = function(wire) {
		if (wire.peerChoking) return;
		if (wire.requests.length >= 5) return;

		if (!wire.downloaded) return onvalidatewire(wire);

		var rank = speedRanker(wire);

		for (var i = 0; i < selection.length; i++) {
			var next = selection[i];
			for (var j = next.from + next.offset; j <= next.to; j++) {
				if (!wire.peerPieces[j] || !rank(j)) continue;

				while (wire.requests.length < 5 && onrequest(wire, j));
				if (wire.requests.length >= 5) return;
			}
		}
	};

	var onupdate = function() {
		wires.forEach(onupdatewire);
	};

	swarm.on('wire', function(wire) {
		wire.setTimeout(opts.timeout || 10000, function() {
			that.emit('timeout', wire);
			wire.destroy();
		});

		wire.bitfield(bits);
		wire.interested();

		var timeout = 5000;
		var id;

		var onchoketimeout = function() {
			wire.destroy();
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
			store.read(index, function(err, buffer) {
				if (err) return cb(err);
				that.emit('upload', index, offset, length);
				cb(null, buffer.slice(offset, length));
			});
		});

		wire.on('unchoke', onupdate);
		wire.on('bitfield', onupdate);
		wire.on('have', onupdate);

		wire.once('interested', function() {
			wire.unchoke();
		});

		id = setTimeout(onchoketimeout, timeout);
		that.emit('wire', wire);
	});

	that.torrent = torrent;
	that.selection = selection;
	that.wires = wires;
	that.store = store;

	that.connect = function(addr) {
		swarm.add(addr);
	};

	that.disconnect = function(addr) {
		swarm.remove(addr);
	};

	that.critical = function(piece, width) {
		for (var i = 0; i < (width || 1); i++) critical[piece+i] = true;
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

	that.__defineGetter__('pieces', function() {
		return pieces.map(function(piece) {
			return !piece;
		});
	});

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