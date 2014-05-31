var ip = require('ip');
var dht = require('bittorrent-dht');

var DHT_SIZE = 10000;

var noop = function() {};

var isPeerBlocked = function(addr, blocklist) {
	var blockedReason = null;
	// TODO: support IPv6
	var searchAddr = ip.toLong(addr);
	for (var i = 0, l = blocklist.length; i < l; i++) {
		var block = blocklist[i];
		if (!block.startAddress || !block.endAddress) continue;
		var startAddress = ip.toLong(block.startAddress);
		var endAddress = ip.toLong(block.endAddress);
		if (searchAddr >= startAddress && searchAddr <= endAddress) {
			blockedReason = block.reason || true;
			break;
		}
	}
	return blockedReason;
};

module.exports = function (engine, opts) {
	var table = dht();
	table.setInfoHash(engine.infoHash);
	if (table.socket) table.socket.on('error', noop);
	table.on('peer', function(addr) {
		var blockedReason = null;
		if (opts.blocklist.length && (blockedReason = isPeerBlocked(addr, opts.blocklist))) {
			engine.emit('blocked-peer', addr, blockedReason);
		} else {
			engine.emit('peer', addr);
			engine.connect(addr);
		}
	});
	table.findPeers(opts.dht || DHT_SIZE); // TODO: be smarter about finding peers
	return table;
};