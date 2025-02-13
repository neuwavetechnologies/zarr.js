'use strict';

class NoAuthSigner {
    async sign(httpRequest, identity, signingProperties) {
        return httpRequest;
    }
}

exports.NoAuthSigner = NoAuthSigner;
//# sourceMappingURL=noAuth-97848040.js.map
