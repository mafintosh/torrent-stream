var engine = require('./engine');
var dht = require('./dht');
var fileStream = require('./file-stream');
var parseTorrent = require('parse-torrent');
var eos = require('end-of-stream');

module.exports = function(torrent, opts) {
	torrent = parseTorrent(torrent);

	var e = engine(torrent, opts);

	e.files = torrent.files.map(function(file) {
		var offsetPiece = (file.offset / torrent.pieceLength) | 0;
		var endPiece = ((file.offset+file.length-1) / torrent.pieceLength) | 0;

		file.deselect = function() {
			e.deselect(offsetPiece, endPiece, false);
		};

		file.select = function() {
			e.select(offsetPiece, endPiece, false);
		};

		file.createReadStream = function(opts) {
			var self = this;
			var stream = fileStream(e, file, opts);

			e.select(stream.startPiece, stream.endPiece, true, stream.notify.bind(stream));
			eos(stream, function() {
				e.deselect(stream.startPiece, stream.endPiece, true);
			});

			return stream;
		};

		return file;
	});

	if (opts.dht === false) return e;

	var table = dht(torrent.infoHash);

	table.on('peer', function(addr) {
		e.connect(addr);
	});

	return e;
};