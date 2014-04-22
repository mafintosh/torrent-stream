var parse  = require('parse-torrent');
var bncode = require('bncode');
var crypto = require('crypto');

var noop = module.exports.noop = function () {};

var sha1 = module.exports.sha1 = function (buf) {
	return crypto.createHash('sha1').update(buf).digest('hex');
};

var encode = module.exports.encode = function (torrent) {
	var info = {};

	info.name = torrent.name;
	if (torrent.private) info.private = 1;

	info.files = torrent.files.map(function(file) {
		return {
			length:file.length,
			path:(file.path.indexOf(info.name) === 0 ? file.path.slice(info.name.length) : file.path).slice(1).split(/\\|\//)
		};
	});

	info['piece length'] = torrent.pieceLength;
	info.pieces = Buffer.concat(torrent.pieces.map(function(buf) {
		return new Buffer(buf, 'hex');
	}));

	var encoded = bncode.encode(info);
	var infoHash = sha1(encoded);

	if (infoHash === torrent.infoHash) return encoded;
	if (!torrent.files.length) return null;

	delete info.files;
	info.length = torrent.files[0].length;

	encoded = bncode.encode(info);
	infoHash = sha1(encoded);

	if (infoHash === torrent.infoHash) return encoded;

	return null;
};
