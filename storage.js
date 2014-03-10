var fs = require('fs');
var path = require('path');
var mkdirp = require('mkdirp');
var rimraf = require('rimraf');
var thunky = require('thunky');
var events = require('events');

var noop = function() {};

module.exports = function(folder, torrent) {
	var that = new events.EventEmitter();

	var mkdir = thunky(function(cb) {
		mkdirp(folder, cb);
	});

	var pad = function(i) {
		return '00000000000'.slice(0, 10-(''+i).length)+i;
	};

	that.read = function(index, cb) {
		mkdir(function(err) {
			if (err) return cb(err);
			fs.readFile(path.join(folder, pad(index)), cb);
		});
	};

	that.write = function(index, buffer, cb) {
		if (!cb) cb = noop;
		mkdir(function(err) {
			if (err) return cb(err);
			fs.writeFile(path.join(folder, pad(index)), buffer, cb);
		});
	};

	that.destroy = function(cb) {
		if (!cb) cb = noop;
		mkdir(function(err) {
			if (err) return cb(err);
			rimraf(folder, cb);
		});
	};

	return that;
};