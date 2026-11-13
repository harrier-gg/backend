# Changelog

## [0.8.0](https://github.com/harrier-gg/backend/compare/v0.7.0...v0.8.0) (2026-11-13)


### Features

* delete servers ([#37](https://github.com/harrier-gg/backend/issues/37)) ([43ad39b](https://github.com/harrier-gg/backend/commit/43ad39b555e149fa32588e0d45ae44d17803e697))
* Hangar as a plugin source for Paper ([#36](https://github.com/harrier-gg/backend/issues/36)) ([923f26d](https://github.com/harrier-gg/backend/commit/923f26d6ccb344c080c584d172c197ac44dbed4e))
* integration settings with encrypted secrets ([#34](https://github.com/harrier-gg/backend/issues/34)) ([e7ab9d7](https://github.com/harrier-gg/backend/commit/e7ab9d7a53c6b61aaad2bdeac83ed9fdb60bd900))
* remove an offline node together with its servers ([#38](https://github.com/harrier-gg/backend/issues/38)) ([47d22d9](https://github.com/harrier-gg/backend/commit/47d22d91d1c0bb3c07d188fdf97fddc2d5f48e14))
* share the content players need as a Modrinth modpack ([#32](https://github.com/harrier-gg/backend/issues/32)) ([a5c0c3d](https://github.com/harrier-gg/backend/commit/a5c0c3d06d58ce3133e30409910b4498b2cf8c1d))

## [0.7.0](https://github.com/harrier-gg/backend/compare/v0.6.0...v0.7.0) (2026-11-12)


### Features

* content providers with Modrinth, installed content and dependencies ([#29](https://github.com/harrier-gg/backend/issues/29)) ([94d1330](https://github.com/harrier-gg/backend/commit/94d13303ba6b369d9d40aa752a9a8b6443c51272))
* content updates, incompatibility after version changes, dependency cleanup ([#31](https://github.com/harrier-gg/backend/issues/31)) ([08a692b](https://github.com/harrier-gg/backend/commit/08a692bd27988389368ffc6d0f36347acaa10d25))

## [0.6.0](https://github.com/harrier-gg/backend/compare/v0.5.0...v0.6.0) (2026-11-11)


### Features

* backup schedule, endpoints and downloads ([#26](https://github.com/harrier-gg/backend/issues/26)) ([78b3081](https://github.com/harrier-gg/backend/commit/78b3081422ba350f5bdc4377381c83a58c040e18))
* file manager endpoints with streamed uploads and downloads ([#24](https://github.com/harrier-gg/backend/issues/24)) ([cc50ed1](https://github.com/harrier-gg/backend/commit/cc50ed1ae981861dc199a9e645e2351cb7e22d38))


### Bug Fixes

* anchor the backup save confirmation to the game's log line ([#27](https://github.com/harrier-gg/backend/issues/27)) ([572d066](https://github.com/harrier-gg/backend/commit/572d066cb5a42e8fab04d570ec0636b71cc5def8))

## [0.5.0](https://github.com/harrier-gg/backend/compare/v0.4.0...v0.5.0) (2026-11-11)


### Features

* Discord bot with /status, /start, /stop and online/crash messages ([#22](https://github.com/harrier-gg/backend/issues/22)) ([b540312](https://github.com/harrier-gg/backend/commit/b5403125320fc27d2dc3898ba7f6add781a18753))

## [0.4.0](https://github.com/harrier-gg/backend/compare/v0.3.0...v0.4.0) (2026-11-11)


### Features

* sleeping servers; sleep after setting and wake on connect ([#20](https://github.com/harrier-gg/backend/issues/20)) ([47948bd](https://github.com/harrier-gg/backend/commit/47948bd2538f582fcd2e1b4b78c0ac313277b8ff))

## [0.3.0](https://github.com/harrier-gg/backend/compare/v0.2.0...v0.3.0) (2026-11-11)


### Features

* create, start and stop game servers from templates ([#10](https://github.com/harrier-gg/backend/issues/10)) ([5f815a6](https://github.com/harrier-gg/backend/commit/5f815a6eab6be9d0ac7f5cff12da0366b0fd9f36))
* Discord login, linking and joining via invitation ([#14](https://github.com/harrier-gg/backend/issues/14)) ([e79a9a1](https://github.com/harrier-gg/backend/commit/e79a9a105d312f216a78b99e478f314f17f64e75))
* edit config files; game settings move to the game's files ([#18](https://github.com/harrier-gg/backend/issues/18)) ([28e5f9a](https://github.com/harrier-gg/backend/commit/28e5f9a5aa0dd4f1d62d939441ffd8101cd99e03))
* edit server settings after creating a server ([9ff7bc4](https://github.com/harrier-gg/backend/commit/9ff7bc40efb38bc2b6177645157c123bd4a69e44))
* player list and resource history ([#15](https://github.com/harrier-gg/backend/issues/15)) ([58d0c47](https://github.com/harrier-gg/backend/commit/58d0c47b75330ca42eebe6923745025fef07a5a5))
* register and remove nodes from the panel ([#13](https://github.com/harrier-gg/backend/issues/13)) ([2f832e3](https://github.com/harrier-gg/backend/commit/2f832e3ea96434add98c52132c410fa7cfbc6919))
* require agent tokens for agent connections ([#8](https://github.com/harrier-gg/backend/issues/8)) ([6b17d9d](https://github.com/harrier-gg/backend/commit/6b17d9da5c09fbee2dadc38aea516cdc56159f0f))
* roles and invitation links ([#12](https://github.com/harrier-gg/backend/issues/12)) ([25d5183](https://github.com/harrier-gg/backend/commit/25d51834c2bdd893e53b1c3bf5a56102e6e84967))
* show pending restarts of crashed servers ([#16](https://github.com/harrier-gg/backend/issues/16)) ([f008d1f](https://github.com/harrier-gg/backend/commit/f008d1facca8849286a3036c22415775a01620fb))
* user login with sessions and first-run setup ([#11](https://github.com/harrier-gg/backend/issues/11)) ([b2fc113](https://github.com/harrier-gg/backend/commit/b2fc113a753922f017bdc0181534f5be4c4c40bb))
* version providers; the Java image follows the version ([#19](https://github.com/harrier-gg/backend/issues/19)) ([d042bda](https://github.com/harrier-gg/backend/commit/d042bdae020a14c55ca69f4f1a63ec7959eeffe4))

## [0.2.0](https://github.com/harrier-gg/backend/compare/harrier-backend-v0.1.0...harrier-backend-v0.2.0) (2026-11-10)


### Features

* Gerüst für Gateway und Servers (M0) ([5188069](https://github.com/harrier-gg/backend/commit/51880698c8f0e0049c52d4d3bbc3aaa2571178ff))


### Bug Fixes

* bump the version in openapi.json on release ([#6](https://github.com/harrier-gg/backend/issues/6)) ([d31ee61](https://github.com/harrier-gg/backend/commit/d31ee61ae7262e8d5f76458b92e104bb1a1be96b))
* **gateway:** Agent-Handshake absichern und nur auf localhost lauschen ([9f1ec8e](https://github.com/harrier-gg/backend/commit/9f1ec8ea260fb63a8d3209c7c8e786f56bc093cf))
* **gateway:** Agent-WebSocket lehnt Verbindungen mit Browser-Origin ab ([c0b8f89](https://github.com/harrier-gg/backend/commit/c0b8f89f2b0e9edec8c5c6d5a96a491b32ebd99d))
