# Filter syntax reference (SIGILS v4.3)

The editor is a syntax assistant only. The CC:Tweaked v4.3 runtime remains authoritative for matching. The UI must preserve the exact expression the user entered.

## Expression composition

- Whitespace separates terms; terms in one group are ANDed.
- `|` separates OR groups.
- Double quotes preserve spaces and `|` inside a term.
- Backslash escapes the next character.
- A leading `!` negates a term.

## Create package address filters

- `#pattern`: Create package address matching using Create-compatible Glob semantics.
- `!#pattern`: negative package address filter.
- `#`: matches blank package addresses.
- Matching is case-sensitive and symmetric: either the stored package address or the configured filter may contain a Glob expression.
- Address is obtained from Create package metadata (`getAddress()` / supported address snapshot), not display name or NBT hash.
- If an item is known to be a Create package but address metadata is unavailable, the address filter fails closed.

### Glob operators

| Operator | Meaning |
|---|---|
| `*` | Zero or more characters |
| `?` | Exactly one Unicode code point |
| `[abc]` | One character from the set |
| `[a-z]` | One character in the range |
| `[!abc]` | One character not in the set |
| `{a,b}` | One of the alternatives; nested braces unsupported |
| `\\x` | Escapes the next character |

Runtime limits in v4.3: 256 UTF-8 bytes, 256 tokens, 64 expanded alternatives.

## Legacy address filter

`addr:text` remains the old case-insensitive substring matcher. It is not converted to Glob and should not be silently rewritten by the editor.

## Examples

| Expression | Meaning |
|---|---|
| `#warehouse` | Address matches `warehouse` |
| `!#warehouse` | Address does not match `warehouse` |
| `#crate-?` | One character after `crate-` |
| `#north-*` | Address starts with `north-` |
| `#{north,south}-[0-9]` | `north` or `south`, followed by a digit |
| `"#Main Depot"` | Address term containing a space |
| `addr:warehouse` | Legacy case-insensitive substring |
| `#warehouse @create` | Address AND mod namespace |
| `#warehouse|#factory` | Either address condition |
