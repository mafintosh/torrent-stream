var events = require('events');
var dht = require('bittorrent-dht');
var tracker = require('bittorrent-tracker');

var DEFAULT_PORT = 6881;

module.exports = function(torrent, opts) {
	if (typeof opts !== 'object') {
		opts = torrent;
		torrent = null;
	}

	var port = opts.port || DEFAULT_PORT;

	var discovery = new events.EventEmitter();

	discovery.dht = null;
	discovery.tracker = null;

	var onpeer = function(addr) {
		discovery.emit('peer', addr);
	};

	var createDHT = function(infoHash) {
		if (opts.dht === false) return;

		var table = dht();

		table.on('peer', onpeer);
		table.on('ready', function() {
			table.lookup(infoHash);
		});
		table.listen();

		return table;
	};

	var createTracker = function(torrent) {
		if (opts.trackers) {
			torrent = Object.create(torrent);
			var trackers = (opts.tracker !== false) && torrent.announce ? torrent.announce : [];
			torrent.announce = trackers.concat(opts.trackers);
		} else if (opts.tracker === false) {
			return;
		}

		if (!torrent.announce || !torrent.announce.length) return;

		var tr = new tracker.Client(new Buffer(opts.id), port, torrent);

		tr.on('peer', onpeer);
		tr.on('error', function() { /* noop */ });

		tr.start();
		return tr;
	};

	discovery.setTorrent = function(t) {
		torrent = t;

		if (discovery.tracker) {
			// If we have tracker then it had probably been created before we got infoDictionary.
			// So client do not know torrent length and can not report right information about uploads
			discovery.tracker.torrentLength = torrent.length;
		} else {
			process.nextTick(function() {
				if (!discovery.dht) discovery.dht = createDHT(torrent.infoHash);
				if (!discovery.tracker) discovery.tracker = createTracker(torrent);
			});
		}
	};

	discovery.updatePort = function(p) {
		if (port === p) return;
		port = p;
		if (discovery.tracker) discovery.tracker.stop();
		if (discovery.dht) discovery.dht.announce(torrent.infoHash, port);
		if (torrent) discovery.tracker = createTracker(torrent);
	};

	discovery.stop = function() {
		if (discovery.tracker) discovery.tracker.stop();
		if (discovery.dht) discovery.dht.destroy();
	};

	if (torrent) discovery.setTorrent(torrent);

	return discovery;
};
