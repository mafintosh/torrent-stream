var fs = require('fs');
var path = require('path');
var raf = require('random-access-file');

var noop = function() {};

module.exports = function(folder, torrent) {
	var that = {};

	var bufferSize = torrent.pieceLength;
	while (bufferSize < 256 * 1024 * 1024) bufferSize *= 2;

	var pieceLength = torrent.pieceLength;
	var pieceRemainder = (torrent.length % pieceLength) || pieceLength;
	var piecesPerBuffer = bufferSize / pieceLength;
	var mem = [];
	var files = [];

	var pad = function(i) {
		return '00000000000'.slice(0, 10-(''+i).length)+i;
	};

	that.read = function(index, cb) {
		if (mem[index]) return cb(null, mem[index]);

		var i = (index / piecesPerBuffer) | 0;
		var offset = index - i * piecesPerBuffer;
		var len = index === torrent.pieces.length-1 ? pieceRemainder : pieceLength;
		var file = files[i] = files[i] || raf(path.join(folder, pad(i)));

		file.read(offset * pieceLength, len, cb);
	};

	that.write = function(index, buffer, cb) {
		if (!cb) cb = noop;

		mem[index] = buffer;

		var ondone = function(err) {
			mem[index] = null;
			cb(err);
		};

		var i = (index / piecesPerBuffer) | 0;
		var file = files[i] = files[i] || raf(path.join(folder, pad(i)));
		var offset = index - i * piecesPerBuffer;

		file.write(offset * pieceLength, buffer, ondone);
	};

	that.close = function(cb) {
		if (!cb) cb = noop;

		var i = 0;
		var loop = function(err) {
			if (err) return cb(err);
			var next = files[i++];
			if (!next) return cb();
			file.close(loop);
		};

		loop();
	};

	return that;
};