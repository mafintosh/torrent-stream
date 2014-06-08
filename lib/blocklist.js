var ip = require('ip');

module.exports = function(blocklist) {
	if (!Array.isArray(blocklist)) {
		return function() { return null; };
	}

	return function(addr) {
		if (!blocklist.length) return false;

		var blockedReason = null;
		var searchAddr = ip.toLong(addr.split(':')[0]); // TODO: support IPv6

		for (var i = 0, l = blocklist.length; i < l; i++) {
			var block = blocklist[i];
			if (!block.startAddress || !block.endAddress) continue;
			if (typeof block.startAddress !== 'number') block.startAddress = ip.toLong(block.startAddress);
			if (typeof block.endAddress !== 'number') block.endAddress = ip.toLong(block.endAddress);
			if (searchAddr >= block.startAddress && searchAddr <= block.endAddress) {
				blockedReason = block.reason || true;
				break;
			}
		}

		return blockedReason;
	};
};
