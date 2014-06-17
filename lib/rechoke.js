var RECHOKE_INTERVAL = 10000;
var RECHOKE_OPTIMISTIC_DURATION = 2;

var rechokeSort = function(a, b) {
	// Prefer higher download speed
	if (a.downSpeed !== b.downSpeed) return a.downSpeed > b.downSpeed ? -1 : 1;
	// Prefer higher upload speed
	if (a.upSpeed !== b.upSpeed) return a.upSpeed > b.upSpeed ? -1 : 1;
	// Prefer unchoked
	if (a.wasChoked !== b.wasChoked) return a.wasChoked ? 1 : -1;
	// Random order
	return a.salt - b.salt;
};

module.exports = function(wires, rechokeSlots) {
	var rechokeOptimistic = null;
	var rechokeOptimisticTime = 0;
	var rechokeIntervalId;

	function rechoke() {
		if (rechokeOptimisticTime > 0) --rechokeOptimisticTime;
		else rechokeOptimistic = null;

		var peers = [];

		wires.forEach(function(wire) {
			if (wire.isSeeder) {
				if (!wire.amChoking) wire.choke();
			} else if (wire !== rechokeOptimistic) {
				peers.push({
					wire:       wire,
					downSpeed:  wire.downloadSpeed(),
					upSpeed:    wire.uploadSpeed(),
					salt:       Math.random(),
					interested: wire.peerInterested,
					wasChoked:  wire.amChoking,
					isChoked:   true
				});
			}
		});

		peers.sort(rechokeSort);

		var i = 0;
		var unchokeInterested = 0;
		for (; i < peers.length && unchokeInterested < rechokeSlots; ++i) {
			peers[i].isChoked = false;
			if (peers[i].interested) ++unchokeInterested;
		}

		if (!rechokeOptimistic && i < peers.length && rechokeSlots) {
			var candidates = peers.slice(i).filter(function(peer) { return peer.interested; });
			var optimistic = candidates[(Math.random() * candidates.length) | 0];

			if (optimistic) {
				optimistic.isChoked = false;
				rechokeOptimistic = optimistic.wire;
				rechokeOptimisticTime = RECHOKE_OPTIMISTIC_DURATION;
			}
		}

		peers.forEach(function(peer) {
			if (peer.wasChoked !== peer.isChoked) {
				if (peer.isChoked) peer.wire.choke();
				else peer.wire.unchoke();
			}
		});
	}

	return {
		start: function() {
			rechokeIntervalId = setInterval(rechoke, RECHOKE_INTERVAL);
		},
		stop: function() {
			clearInterval(rechokeIntervalId);
		}
	};
};