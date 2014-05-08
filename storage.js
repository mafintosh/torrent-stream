var fs = require('fs');
var path = require('path');
var raf = require('random-access-file');
var mkdirp = require('mkdirp');
var thunky = require('thunky');

var noop = function() {};

module.exports = function(folder, torrent) {
	var that = {};

	var destroyed = false;
	var piecesMap = [];
	var pieceLength = torrent.pieceLength;
	var files = [];

	torrent.files.forEach(function(file, idx) {
		var fileStart = file.offset;
		var fileEnd   = file.offset + file.length;

		var firstPiece = Math.floor(fileStart / pieceLength);
		var lastPiece  = Math.floor((fileEnd - 1) / pieceLength);

		var open = thunky(function(cb) {
			var filePath = path.join(folder, file.path);
			var fileDir  = path.dirname(filePath);

			mkdirp(fileDir, function(err) {
				if (err) return cb(err);
				if (destroyed) return cb(new Error('Storage destroyed'));

				var f = raf(filePath);
				files.push(f);
				cb(null, f);
			});
		});

		for (var p = firstPiece; p <= lastPiece; ++p) {
			var pieceStart = p * pieceLength;
			var pieceEnd   = pieceStart + pieceLength;

			var from   = (fileStart < pieceStart) ? 0 : fileStart - pieceStart;
			var to     = (fileEnd > pieceEnd) ? pieceLength : fileEnd - pieceStart;
			var offset = (fileStart > pieceStart) ? 0 : pieceStart - fileStart;

			if (!piecesMap[p]) piecesMap[p] = [];

			piecesMap[p].push({
				from:    from,
				to:      to,
				offset:  offset,
				file:    idx,
				open:    open
			});
		}
	});

	var mem = [];

	that.read = function(index, cb) {
		if (mem[index]) return cb(null, mem[index]);

		var buffers = [];
		var targets = piecesMap[index];
		var i = 0;
		var end = targets.length;

		var next = function(err, buffer) {
			if (err) return cb(err);
			if (buffer) buffers.push(buffer);
			if (i >= end) return cb(null, Buffer.concat(buffers));

			var target = targets[i++];
			target.open(function(err, file) {
				if (err) return cb(err);
				file.read(target.offset, target.to - target.from, next);
			});
		};

		next();
	};

	that.write = function(index, buffer, cb) {
		if (!cb) cb = noop;

		mem[index] = buffer;

		var targets = piecesMap[index];
		var i = 0;
		var end = targets.length;

		var next = function(err) {
			if (err) return cb(err);
			if (i >= end) {
				mem[index] = null;
				return cb();
			}

			var target = targets[i++];
			target.open(function(err, file) {
				if (err) return cb(err);
				file.write(target.offset, buffer.slice(target.from, target.to), next);
			});
		};

		next();
	};

	that.close = function(cb) {
		if (!cb) cb = noop;
		destroyed = true;

		var i = 0;
		var loop = function(err) {
			if (i >= files.length) return cb();
			if (err) return cb(err);
			var next = files[i++];
			if (!next) return process.nextTick(loop);
			next.close(loop);
		};

		process.nextTick(loop);
	};

	return that;
};