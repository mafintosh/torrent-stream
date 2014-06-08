var ip = require('ip');

module.exports = function(blocklist) {
	if (!Array.isArray(blocklist)) {
		return function() { return null; };
	}

	return function(addr) {
		if (!blocklist.length) return false;

		var blockedReason = null;
		var searchAddr = ip.toLong(addr); // TODO: support IPv6

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
};
