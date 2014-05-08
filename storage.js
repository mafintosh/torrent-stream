var fs = require('fs');
var path = require('path');
var raf = require('random-access-file');
var mkdirp = require('mkdirp');

var noop = function() {};

module.exports = function(folder, torrent) {
	var that = {};

	var piecesMap = [];
	var pieceLength = torrent.pieceLength;

	torrent.files.forEach(function(file, idx) {
		var file_start = file.offset;
		var file_end   = file.offset + file.length;

		var first_piece = Math.floor(file_start / pieceLength);
		var last_piece  = Math.floor((file_end - 1) / pieceLength);

		for (var p = first_piece; p <= last_piece; ++p) {
			var piece_start = p * pieceLength;
			var piece_end   = piece_start + pieceLength;

			var from  = (file_start < piece_start) ? 0 : file_start - piece_start;
			var to    = (file_end > piece_end) ? pieceLength : file_end - piece_start;
			var offset = (file_start > piece_start) ? 0 : piece_start - file_start;

			if (!piecesMap[p]) piecesMap[p] = [];

			piecesMap[p].push({
				from:    from,
				to:      to,
				offset:  offset,
				file:    idx
			});
		}
	});

	var mem = [];
	var files = [];

	var openFile = function(idx) {
		var file_path = path.join(folder, torrent.files[idx].path);
		var file_dir  = path.dirname(file_path);

		// Making openFile async would require more refactoring
		mkdirp.sync(file_dir);

		return files[idx] = raf(file_path);
	};

	that.read = function(index, cb) {
		if (mem[index]) return cb(null, mem[index]);

		var buffers = [];

		var targets = piecesMap[index];
		var i = 0, end = targets.length;

		var next = function(err, buffer) {
			if (err) return cb(err);
			if (buffer) buffers.push(buffer);
			if (i >= end) {
				return cb(err, Buffer.concat(buffers));
			}

			var target = targets[i++];
			var file = files[target.file] || openFile(target.file);
			file.read(target.offset, (target.to - target.from), next);
		};

		next();
	};

	that.write = function(index, buffer, cb) {
		if (!cb) cb = noop;

		mem[index] = buffer;

		var targets = piecesMap[index];
		var i = 0, end = targets.length;

		var next = function(err) {
			if (err) return cb(err);
			if (i >= end) {
				delete mem[index];
				return cb(err);
			}

			var target = targets[i++];
			var file = files[target.file] || openFile(target.file);
			file.write(target.offset, buffer.slice(target.from, target.to), next);
		};

		next();
	};

	that.close = function(cb) {
		if (!cb) cb = noop;

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