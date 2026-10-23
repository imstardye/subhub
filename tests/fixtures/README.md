# Test fixtures

These files are copied from the public repository
[jhxxr/script](https://github.com/jhxxr/script):

- `rule/xr_all_config_v2.ini`
- `rule/xr_all_config_v2_legacy.ini`

They are used only to test subconverter-style `ruleset=` and
`custom_proxy_group=` parsing.

## Sanitization check

Before committing, the files were checked for real subscription URLs, tokens,
passwords and private domains. The only URLs present are public GitHub raw rule
list URLs (for example `raw.githubusercontent.com/...`). There are no
credentials or private hostnames in either file.

If you refresh these fixtures from upstream, repeat that check first and
replace any private value with `example.com`.
