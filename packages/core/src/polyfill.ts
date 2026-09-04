/**
 * Explicit Resource Management symbols. Engines without them (older Firefox and WebKit) would
 * otherwise turn `obj[Symbol.dispose]` into `obj["undefined"]`. Same fallback TypeScript's own
 * `using` helpers use, so transpiled code and this library agree on the symbol.
 */
const S = Symbol as unknown as { dispose?: symbol; asyncDispose?: symbol };
S.dispose ??= Symbol.for('Symbol.dispose');
S.asyncDispose ??= Symbol.for('Symbol.asyncDispose');
