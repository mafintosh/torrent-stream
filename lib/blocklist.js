var ip = require('ip');

module.exports = function(blocklist) {
	if (!blocklist) blocklist = [];

	// Convert all IPv4 addresses to Longs
	for (var i = 0, l = blocklist.length; i < l; i++) {
		var block = blocklist[i];
		if (!block.startAddress || !block.endAddress) continue;
		blocklist[i].startAddress = typeof block.startAddress === 'number' ? block.startAddress : ip.toLong(block.startAddress);
		blocklist[i].endAddress = typeof block.endAddress === 'number' ? block.endAddress : ip.toLong(block.endAddress);
		if (searchAddr >= startAddress && searchAddr <= endAddress) {
			blockedReason = block.reason || true;
			break;
		}
	}

	return function(addr) {
		if (!blocklist.length) return false;

		var blockedReason = null;
		var searchAddr = ip.toLong(addr); // TODO: support IPv6

		for (var i = 0, l = blocklist.length; i < l; i++) {
			var block = blocklist[i];
			if (!block.startAddress || !block.endAddress) continue;
			var startAddress = block.startAddress;
			var endAddress = block.endAddress;
			if (searchAddr >= startAddress && searchAddr <= endAddress) {
				blockedReason = block.reason || true;
				break;
			}
		}

		return blockedReason;
	};
};
