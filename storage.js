var fs = require('fs');
var path = require('path');
var mkdirp = require('mkdirp');
var rimraf = require('rimraf');
var thunky = require('thunky');
var events = require('events');
var raf = require('random-access-file');

var noop = function() {};

module.exports = function(folder, torrent) {
	var that = new events.EventEmitter();

	var bufferSize = torrent.pieceLength;
	while (bufferSize < 256 * 1024 * 1024) bufferSize *= 2;

	var pieceLength = torrent.pieceLength;
	var pieceRemainder = (torrent.length % pieceLength) || pieceLength;
	var piecesPerBuffer = bufferSize / pieceLength;

	var mkdir = thunky(function(cb) {
		mkdirp(folder, cb);
	});

	var pad = function(i) {
		return '00000000000'.slice(0, 10-(''+i).length)+i;
	};

	var files = [];

	that.read = function(index, cb) {
		mkdir(function(err) {
			if (err) return cb(err);

			var i = (index / piecesPerBuffer) | 0;
			var offset = index - i * piecesPerBuffer;
			var len = index === torrent.pieces.length-1 ? pieceRemainder : pieceLength;
			var file = files[i] = files[i] || raf(path.join(folder, pad(i)));

			file.read(offset * pieceLength, len, cb);
		});
	};

	that.write = function(index, buffer, cb) {
		if (!cb) cb = noop;
		mkdir(function(err) {
			if (err) return cb(err);

			var i = (index / piecesPerBuffer) | 0;
			var file = files[i] = files[i] || raf(path.join(folder, pad(i)));
			var offset = index - i * piecesPerBuffer;

			file.write(offset * pieceLength, buffer, cb);
		});
	};

	that.destroy = function(cb) {
		if (!cb) cb = noop;

		files.forEach(function(file) {
			file.close();
		});

		mkdir(function(err) {
			if (err) return cb(err);
			rimraf(folder, cb);
		});
	};

	return that;
};