var bitfield = require('bitfield');
var crypto = require('crypto');

var piece = require('./piece');
var storage = require('./storage');

var MAX_REQUESTS = 5;
var CHOKE_TIMEOUT = 5000;
var REQUEST_TIMEOUT = 30000;
var SPEED_THRESHOLD = 3 * piece.BLOCK_SIZE;

var BAD_PIECE_STRIKES_MAX = 3;
var BAD_PIECE_STRIKES_DURATION = 120000; // 2 minutes

var sha1 = function(data) {
	return crypto.createHash('sha1').update(data).digest('hex');
};

var thruthy = function() {
	return true;
};

var falsy = function() {
	return false;
};

module.exports = function(engine, torrent, critical, opts) {
	engine.store = (opts.storage || storage(opts.path))(torrent, opts);
	engine.torrent = torrent;
	engine.bitfield = bitfield(torrent.pieces.length);

	var pieceLength = torrent.pieceLength;
	var pieceRemainder = (torrent.length % pieceLength) || pieceLength;

	var pieces = torrent.pieces.map(function(hash, i) {
		return piece(i === torrent.pieces.length - 1 ? pieceRemainder : pieceLength);
	});
	var reservations = torrent.pieces.map(function() {
		return [];
	});
	var swarm = engine.swarm;
	var wires = swarm.wires;

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

			while (!pieces[s.from + s.offset] && s.from + s.offset < s.to) s.offset++;

			if (oldOffset !== s.offset) s.notify();
			if (s.to !== s.from + s.offset) continue;
			if (pieces[s.from + s.offset]) continue;

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

		for (i = 0; i < r.length; i++) {
			if (r[i] === min) r[i] = null;
		}

		for (i = 0; i < min.requests.length; i++) {
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

			if (!p.set(reservation, block, wire)) return onupdatetick();

			var sources = p.sources;
			var buffer = p.flush();

			if (sha1(buffer) !== torrent.pieces[index]) {
				pieces[index] = piece(p.length);
				engine.emit('invalid-piece', index, buffer);
				onupdatetick();

				sources.forEach(function(wire) {
					var now = Date.now();

					wire.badPieceStrikes = wire.badPieceStrikes.filter(function(strike) {
						return (now - strike) < BAD_PIECE_STRIKES_DURATION;
					});

					wire.badPieceStrikes.push(now);

					if (wire.badPieceStrikes.length > BAD_PIECE_STRIKES_MAX) {
						engine.block(wire.peerAddress);
					}
				});

				return;
			}

			onpiececomplete(index, buffer);
			onupdatetick();
		});

		return true;
	};

	var onvalidatewire = function(wire) {
		if (wire.requests.length) return;

		for (var i = engine.selection.length - 1; i >= 0; i--) {
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

				if (otherSpeed < SPEED_THRESHOLD) continue;
				if (otherSpeed <= speed || !other.peerPieces[index]) continue;
				if ((missing -= otherSpeed * secs) > 0) continue;

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
			engine.store.read(index, { offset: offset, length: length }, function(err, buffer) {
				if (err) return cb(err);
				engine.emit('upload', index, offset, length);
				cb(null, buffer);
			});
		});

		wire.on('unchoke', onupdate);
		wire.on('bitfield', onupdate);
		wire.on('have', onupdate);

		wire.isSeeder = false;

		var i = 0;
		var checkseeder = function() {
			if (wire.peerPieces.length !== torrent.pieces.length) return;
			for (; i < torrent.pieces.length; ++i) {
				if (!wire.peerPieces[i]) return;
			}
			wire.isSeeder = true;
		};

		wire.on('bitfield', checkseeder);
		wire.on('have', checkseeder);
		checkseeder();

		wire.badPieceStrikes = [];

		id = setTimeout(onchoketimeout, timeout);
	};

	var onready = function() {
		swarm.on('wire', onwire);
		swarm.wires.forEach(onwire);

		var refresh = function() {
			process.nextTick(gc);
			oninterestchange();
			onupdate();
		};

		refresh();
		engine.on('refresh', refresh);
		engine.emit('ready');
	};

	if (opts.verify === false) return onready();

	engine.emit('verifying');

	var loop = function(i) {
		if (i >= torrent.pieces.length) return onready();
		engine.store.read(i, function(_, buf) {
			if (!buf || sha1(buf) !== torrent.pieces[i] || !pieces[i]) return loop(i + 1);
			pieces[i] = null;
			engine.bitfield.set(i, true);
			engine.emit('verify', i);
			loop(i + 1);
		});
	};

	loop(0);
};
