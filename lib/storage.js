var fs = require('fs');
var path = require('path');
var raf = require('random-access-file');
var mkdirp = require('mkdirp');
var rimraf = require('rimraf');
var thunky = require('thunky');

var noop = function() {};

module.exports = function(folder) {
	return function(torrent) {
		var that = {};

		var destroyed = false;
		var piecesMap = [];
		var pieceLength = torrent.pieceLength;
		var files = [];

		var nonExistent = new Error('Non-existent file');

		torrent.files.forEach(function(file) {
			var fileStart = file.offset;
			var fileEnd = file.offset + file.length;

			var firstPiece = Math.floor(fileStart / pieceLength);
			var lastPiece = Math.floor((fileEnd - 1) / pieceLength);

			var filePath = path.join(folder, file.path);

			var openWrite = thunky(function(cb) {
				mkdirp(path.dirname(filePath), function(err) {
					if (err) return cb(err);
					if (destroyed) return cb(new Error('Storage destroyed'));

					var f = raf(filePath);
					files.push(f);
					cb(null, f);
				});
			});

			var openRead = thunky(function(cb) {
				fs.exists(filePath, function(exists) {
					if (exists) return openWrite(cb);
					cb(nonExistent);
				});
			});

			for (var p = firstPiece; p <= lastPiece; ++p) {
				var pieceStart = p * pieceLength;
				var pieceEnd = pieceStart + pieceLength;

				var from = (fileStart < pieceStart) ? 0 : fileStart - pieceStart;
				var to = (fileEnd > pieceEnd) ? pieceLength : fileEnd - pieceStart;
				var offset = (fileStart > pieceStart) ? 0 : pieceStart - fileStart;

				if (!piecesMap[p]) piecesMap[p] = [];

				piecesMap[p].push({
					from: from,
					to: to,
					offset: offset,
					openWrite: openWrite,
					openRead: openRead
				});
			}
		});

		that.read = function(index, range, cb) {
			if (typeof range === 'function') {
				cb = range;
				range = false;
			}

			if (range) {
				var rangeFrom = range.offset || 0;
				var rangeTo = range.length ? rangeFrom + range.length : pieceLength;
				if (rangeFrom === rangeTo) return cb(null, new Buffer(0));
			}

			var targets = piecesMap[index];
			if (range) {
				targets = targets.filter(function(target) {
					return (target.to > rangeFrom && target.from < rangeTo);
				});

				if (!targets.length) return cb(new Error('no file matching the requested range?'));
			}

			if (!targets) return cb(new Error('no targets for the given index?'));

			var buffers = [];
			var i = 0;
			var end = targets.length;

			var next = function(err, buffer) {
				if (err) return cb(err);
				if (buffer) buffers.push(buffer);
				if (i >= end) return cb(null, Buffer.concat(buffers));

				var target = targets[i++];

				var from = target.from;
				var to = target.to;
				var offset = target.offset;

				if (range) {
					if (to > rangeTo) to = rangeTo;
					if (from < rangeFrom) {
						offset += rangeFrom - from;
						from = rangeFrom;
					}
				}

				target.openRead(function(err, file) {
					if (err) return (err === nonExistent) ? cb(null, new Buffer(0)) : cb(err);
					file.read(offset, to - from, next);
				});
			};

			next();
		};

		that.write = function(index, buffer, cb) {
			if (!cb) cb = noop;

			var targets = piecesMap[index];
			var i = 0;
			var end = targets.length;

			var next = function(err) {
				if (err) return cb(err);
				if (i >= end) return cb();

				var target = targets[i++];
				target.openWrite(function(err, file) {
					if (err) return cb(err);
					file.write(target.offset, buffer.slice(target.from, target.to), next);
				});
			};

			next();
		};

		that.remove = function(cb) {
			if (!cb) cb = noop;
			if (!torrent.files.length) return cb();

			that.close(function(err) {
				if (err) return cb(err);
				var root = torrent.files[0].path.split(path.sep)[0];
				rimraf(path.join(folder, root), { maxBusyTries: 60 }, cb);
			});
		};

		that.close = function(cb) {
			if (!cb) cb = noop;
			if (destroyed) return cb();
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
};
