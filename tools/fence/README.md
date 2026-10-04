# Publication fence

Local pre-commit scans exact staged blobs, not working-tree copies. Pre-push scans every reachable committed tree, including historical versions, not just the current diff. Both run gitleaks with its default rules and require the private instance file. Findings report rule names only, never matched values or file paths.

The denylist rejects private IPv4 ranges, carrier-grade NAT addresses, tailnet DNS names, private host suffixes, account home paths, credential-name patterns, and email addresses except the bot's noreply identity. Instance literals cover host aliases, domains, IPv4 and IPv6 addresses, sites and credential names. Paths are scanned as well as content. Local Brain, harness files, source mirrors, env values and Alchemy state cannot be staged for publication.

The private configuration defaults to `~/.config/rats-nest/instance.json`. Override it with `RATS_NEST_INSTANCE`. It must have mode 600 and contain nonempty string arrays for every field in [the schema](instance.schema.json). Missing, malformed or broadly readable configuration fails closed. [The example](../../config/instance.example.json) contains invented values, not an inventory.

```sh
node tools/fence/cli.ts --mode staged
node tools/fence/cli.ts --mode tree
node tools/fence/cli.ts --mode history
```

Install gitleaks with `brew install gitleaks` on macOS. Hooks are installed by `pnpm install`.

CI cannot read the private instance file. It uses `--generic` and gitleaks on every reachable commit. Generic rules cannot discover an unknown bare host alias or site label. Local checks with a current, complete private inventory are the publication gate; green CI is not evidence that instance-specific data is absent.

The scanner inspects raw blobs, including binary data, but does not unpack archives or decode deliberately obfuscated values. Do not stage compressed or encoded private artifacts. A hook is not an authorization grant and can be bypassed outside this project; owner approval remains required.
