'use strict';

const createAggregatedClient = (commands, Client) => {
    for (const command of Object.keys(commands)) {
        const CommandCtor = commands[command];
        const methodImpl = async function (args, optionsOrCb, cb) {
            const command = new CommandCtor(args);
            if (typeof optionsOrCb === "function") {
                this.send(command, optionsOrCb);
            }
            else if (typeof cb === "function") {
                if (typeof optionsOrCb !== "object")
                    throw new Error(`Expected http options but got ${typeof optionsOrCb}`);
                this.send(command, optionsOrCb || {}, cb);
            }
            else {
                return this.send(command, optionsOrCb);
            }
        };
        const methodName = (command[0].toLowerCase() + command.slice(1)).replace(/Command$/, "");
        Client.prototype[methodName] = methodImpl;
    }
};

var name = "@aws-sdk/nested-clients";
var version = "3.744.0";
var description = "Nested clients for AWS SDK packages.";
var main = "./dist-cjs/index.js";
var module$1 = "./dist-es/index.js";
var types = "./dist-types/index.d.ts";
var scripts = {
	build: "yarn lint && concurrently 'yarn:build:cjs' 'yarn:build:es' 'yarn:build:types'",
	"build:cjs": "node ../../scripts/compilation/inline nested-clients",
	"build:es": "tsc -p tsconfig.es.json",
	"build:include:deps": "lerna run --scope $npm_package_name --include-dependencies build",
	"build:types": "tsc -p tsconfig.types.json",
	"build:types:downlevel": "downlevel-dts dist-types dist-types/ts3.4",
	clean: "rimraf ./dist-* && rimraf *.tsbuildinfo",
	lint: "node ../../scripts/validation/submodules-linter.js --pkg nested-clients",
	test: "yarn g:vitest run",
	"test:watch": "yarn g:vitest watch"
};
var engines = {
	node: ">=18.0.0"
};
var author = {
	name: "AWS SDK for JavaScript Team",
	url: "https://aws.amazon.com/javascript/"
};
var license = "Apache-2.0";
var dependencies = {
	"@aws-crypto/sha256-browser": "5.2.0",
	"@aws-crypto/sha256-js": "5.2.0",
	"@aws-sdk/core": "3.744.0",
	"@aws-sdk/middleware-host-header": "3.734.0",
	"@aws-sdk/middleware-logger": "3.734.0",
	"@aws-sdk/middleware-recursion-detection": "3.734.0",
	"@aws-sdk/middleware-user-agent": "3.744.0",
	"@aws-sdk/region-config-resolver": "3.734.0",
	"@aws-sdk/types": "3.734.0",
	"@aws-sdk/util-endpoints": "3.743.0",
	"@aws-sdk/util-user-agent-browser": "3.734.0",
	"@aws-sdk/util-user-agent-node": "3.744.0",
	"@smithy/config-resolver": "^4.0.1",
	"@smithy/core": "^3.1.2",
	"@smithy/fetch-http-handler": "^5.0.1",
	"@smithy/hash-node": "^4.0.1",
	"@smithy/invalid-dependency": "^4.0.1",
	"@smithy/middleware-content-length": "^4.0.1",
	"@smithy/middleware-endpoint": "^4.0.3",
	"@smithy/middleware-retry": "^4.0.4",
	"@smithy/middleware-serde": "^4.0.2",
	"@smithy/middleware-stack": "^4.0.1",
	"@smithy/node-config-provider": "^4.0.1",
	"@smithy/node-http-handler": "^4.0.2",
	"@smithy/protocol-http": "^5.0.1",
	"@smithy/smithy-client": "^4.1.3",
	"@smithy/types": "^4.1.0",
	"@smithy/url-parser": "^4.0.1",
	"@smithy/util-base64": "^4.0.0",
	"@smithy/util-body-length-browser": "^4.0.0",
	"@smithy/util-body-length-node": "^4.0.0",
	"@smithy/util-defaults-mode-browser": "^4.0.4",
	"@smithy/util-defaults-mode-node": "^4.0.4",
	"@smithy/util-endpoints": "^3.0.1",
	"@smithy/util-middleware": "^4.0.1",
	"@smithy/util-retry": "^4.0.1",
	"@smithy/util-utf8": "^4.0.0",
	tslib: "^2.6.2"
};
var devDependencies = {
	concurrently: "7.0.0",
	"downlevel-dts": "0.10.1",
	rimraf: "3.0.2",
	typescript: "~5.2.2"
};
var typesVersions = {
	"<4.0": {
		"dist-types/*": [
			"dist-types/ts3.4/*"
		]
	}
};
var files = [
	"./sso-oidc.d.ts",
	"./sso-oidc.js",
	"./sts.d.ts",
	"./sts.js",
	"dist-*/**"
];
var browser = {
	"./dist-es/submodules/sso-oidc/runtimeConfig": "./dist-es/submodules/sso-oidc/runtimeConfig.browser",
	"./dist-es/submodules/sts/runtimeConfig": "./dist-es/submodules/sts/runtimeConfig.browser"
};
var homepage = "https://github.com/aws/aws-sdk-js-v3/tree/main/packages/nested-clients";
var repository = {
	type: "git",
	url: "https://github.com/aws/aws-sdk-js-v3.git",
	directory: "packages/nested-clients"
};
var exports$1 = {
	"./sso-oidc": {
		module: "./dist-es/submodules/sso-oidc/index.js",
		node: "./dist-cjs/submodules/sso-oidc/index.js",
		"import": "./dist-es/submodules/sso-oidc/index.js",
		require: "./dist-cjs/submodules/sso-oidc/index.js",
		types: "./dist-types/submodules/sso-oidc/index.d.ts"
	},
	"./sts": {
		module: "./dist-es/submodules/sts/index.js",
		node: "./dist-cjs/submodules/sts/index.js",
		"import": "./dist-es/submodules/sts/index.js",
		require: "./dist-cjs/submodules/sts/index.js",
		types: "./dist-types/submodules/sts/index.d.ts"
	}
};
var packageInfo = {
	name: name,
	version: version,
	description: description,
	main: main,
	module: module$1,
	types: types,
	scripts: scripts,
	engines: engines,
	author: author,
	license: license,
	dependencies: dependencies,
	devDependencies: devDependencies,
	typesVersions: typesVersions,
	files: files,
	browser: browser,
	"react-native": {
},
	homepage: homepage,
	repository: repository,
	exports: exports$1
};

exports.createAggregatedClient = createAggregatedClient;
exports.packageInfo = packageInfo;
//# sourceMappingURL=package-3fbc2706.js.map
