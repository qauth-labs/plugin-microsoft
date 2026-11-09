`qauth-labs-plugin-sdk-0.2.2.tgz` is `@qauth-labs/plugin-sdk` as qauth-labs/qauth's release CI packed it (a dry run) on PR #1069 at f6289fc2, the SDK with the upstream OpenID Connect preset shape (qauth-labs/qauth#671).
Its manifest says `0.2.2` because a dry run stamps the newest version in QAuth's CHANGELOG. It is not npm's `@qauth-labs/plugin-sdk@0.2.2`, which has no preset shape and cannot load this plugin: never switch to that version.
It is temporary: once the SDK release that carries qauth-labs/qauth#671 is on npm, the plugin depends on that version and this directory goes.
