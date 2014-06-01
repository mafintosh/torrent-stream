var tracker = require('bittorrent-tracker');
var DEFAULT_PORT = 6881;

module.exports = function (engine, opts) {
	return function(torrent) {
		if (opts.trackers) {
			torrent = Object.create(torrent);
			var trackers = (opts.tracker !== false) && torrent.announce ? torrent.announce : [];
			torrent.announce = trackers.concat(opts.trackers);
		} else if (opts.tracker === false) {
			return;
		}

		if (!torrent.announce || !torrent.announce.length) return;

		var tr = new tracker.Client(new Buffer(opts.id), engine.port || DEFAULT_PORT, torrent);

		tr.on('peer', function(addr) {
			engine.connect(addr);
		});

		tr.on('error', function() {});

		tr.start();
		return tr;
	};
};
