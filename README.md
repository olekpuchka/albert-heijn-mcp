<p align="center"><img src="assets/logo.png" alt="" width="128" height="128"></p>

# albert-heijn-mcp

[![npm](https://img.shields.io/npm/v/albert-heijn-mcp?color=cb3837&logo=npm)](https://www.npmjs.com/package/albert-heijn-mcp)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Node.js 24](https://img.shields.io/badge/node-24%20LTS-339933?logo=node.js&logoColor=white)](.nvmrc)
[![MCP](https://img.shields.io/badge/MCP-server-6E56CF)](https://modelcontextprotocol.io)

**Your Albert Heijn account, in your AI assistant.**

Connect your Albert Heijn account to an AI assistant such as Claude, ChatGPT or Cursor, and do your grocery shopping by just asking. Find products and bonus deals, plan meals from Allerhande recipes, keep your shopping list and delivery order up to date, and look back at what you've bought.

Technically, it's a [Model Context Protocol](https://modelcontextprotocol.io) (MCP) server for Albert Heijn 🇳🇱. MCP is the standard way AI apps connect to other services, so it works with any app that supports MCP.

> [!NOTE]
> An unofficial project, not affiliated with or endorsed by Albert Heijn. It uses the same API as the AH mobile app, which may change without notice.

---

## Contents

**For everyone**

- [What you can ask](#what-you-can-ask)
- [Getting started](#getting-started): [connect your app](#connecting-a-client), then [log in](#logging-in)
- [Troubleshooting](#troubleshooting)

**Technical details**

- [Running it on a server](#running-it-on-a-server) for ChatGPT and Claude.ai
- [Configuration](#configuration)
- [Tools](#tools) and [limitations](#limitations)
- [Development](#development)

## What you can ask

Ask in Dutch, English or any language your assistant speaks:

> *"Wat is er deze week in de bonus van wat ik meestal koop?"*

**Plan meals**

> *"Find a vegetarian Allerhande recipe under 30 minutes for two, and put the ingredients on my shopping list. I already have olive oil and salt."*

> *"Scale the panlasagne recipe to six people and tell me how much salmon I need."*

> *"Plan three weeknight dinners around what's on bonus this week."*

> *"Put everything for the recipes in my AH meal planner on my shopping list."*

**Save money**

> *"Which products I usually buy are on bonus this week?"*

> *"Rebuild tonight's stir-fry with ingredients that are on bonus, without changing the recipe too much."*

> *"Is next week's bonus out yet? If not, when does it appear?"*

> *"Which of my personal offers are worth activating this week?"*

> *"How many koopzegels do I have, and what are they worth?"*

> *"What's in the 2+1 gratis kaas deal?"*

**Shop**

> *"Put the products I buy most back on my list."*

> *"What's this product, and is it on bonus?"* (with a photo of its barcode)

> *"What's the cheapest cheese at AH right now?"*

> *"Find organic, gluten-free pasta, cheapest first."*

> *"Compare the protein and sugar in these three yoghurts and add the best one to my list."*

> *"When can AH deliver on Saturday?"*

> *"The courgettes are sold out. What else would work in this recipe?"*

> *"Add two more packs of milk to my upcoming delivery."*

> *"Make a favourites list called Pasta night with everything from this recipe."*

> *"Any vandaag-af bread or vegetables at my local AH worth picking up tonight?"*

**Look back**

> *"How much did my in-store receipts add up to in September, and what were the five priciest items?"*

> *"Show the receipt from my last shop and list anything I bought more than once."*

## Getting started

You need an Albert Heijn account. Then:

1. **[Connect your app](#connecting-a-client)**: pick yours below.
2. **[Log in to Albert Heijn](#logging-in)**: ask your assistant to log you in, once.
3. **Ask away.** See [what you can ask](#what-you-can-ask).

## Connecting a client

| Your app | How |
|---|---|
| **Claude Desktop** | [Download and double-click](#claude-desktop). Easiest; nothing else to install. |
| **Cursor**, **VS Code** | [One-click install button](#cursor-and-vs-code) |
| **ChatGPT**, **Claude.ai** (web and mobile) | [Needs your own server](#chatgpt-and-claudeai) (technical) |
| **Other apps** | [Add a command to the app's settings](#other-apps) |

### Claude Desktop

1. Download [`albert-heijn-mcp.mcpb`](https://github.com/olekpuchka/albert-heijn-mcp/releases/latest/download/albert-heijn-mcp.mcpb).
2. Double-click it and choose **Install**. If it doesn't open in Claude, go to Settings → Extensions → Advanced settings → Install Extension… and pick the file.

That's it: the file contains everything it needs. To update, do the same with the file from the newest release.

Other desktop apps that support [MCP Bundles](https://github.com/modelcontextprotocol/mcpb) (`.mcpb` files) install it the same way.

### Cursor and VS Code

Install [Node.js 24 (LTS)](https://nodejs.org) first, then click:

[![Install in Cursor](https://img.shields.io/badge/Cursor-Install_server-000000?logo=cursor&logoColor=white)](https://cursor.com/en/install-mcp?name=ah&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsImFsYmVydC1oZWlqbi1tY3AiXX0%3D)
[![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_server-0098FF)](https://insiders.vscode.dev/redirect/mcp/install?name=ah&config=%7B%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22albert-heijn-mcp%22%5D%7D)

### ChatGPT and Claude.ai

Web and mobile apps can't run anything on your computer; they only connect to servers on the internet. So you first need to [run it on a server](#running-it-on-a-server), which takes some technical know-how. Then add it as a connector:

- **ChatGPT** needs Developer mode (Plus, Pro, Business, Enterprise and Education). Open Settings → advanced settings, turn on Developer mode, and create a connector with `https://your-server/mcp`. Set authentication to **OAuth**.
- **Claude.ai**: Settings → Connectors → Add custom connector, paste `https://your-server/mcp` and choose Connect.

The app then opens a login page on your server: enter your `AH_MCP_TOKEN` there, once.

### Other apps

Apps that start MCP servers as a local command need [Node.js 24 (LTS)](https://nodejs.org) and run `npx -y albert-heijn-mcp`, which downloads and runs the [latest version](https://www.npmjs.com/package/albert-heijn-mcp). Most of them take this JSON in their MCP settings:

```json
{
  "mcpServers": {
    "ah": {
      "command": "npx",
      "args": ["-y", "albert-heijn-mcp"]
    }
  }
}
```

Where the settings live differs per app; see its documentation. Apps with a command line usually have an add command instead, e.g. `<client> mcp add ah -- npx -y albert-heijn-mcp`. It is also listed in the [MCP Registry](https://registry.modelcontextprotocol.io), which some apps install from.

To install it permanently instead, run `npm install --global albert-heijn-mcp` and use the `albert-heijn-mcp` command; run the same command again to update.

> [!TIP]
> Desktop apps don't load your shell profile, so they may not find `npx` (common with nvm). Then set `command` to the output of `which npx`.

## Logging in

Ask your assistant to log you in to Albert Heijn. You only do this once; the login is then kept and renewed automatically.

**On your computer** (Claude Desktop, Cursor, VS Code and other local apps), a separate browser window opens with AH's login page. Log in there as usual: the window closes by itself and you're logged in. Then tell your assistant you're done.

The window uses a fresh, empty browser profile, so type your password: saved passwords and password-manager extensions aren't available there. It needs Chrome, Edge, Brave or Chromium (not the snap version on Ubuntu) and a screen; otherwise you copy the code by hand as below.

**On a server** (ChatGPT, Claude.ai), or when no login window can open, you copy a code by hand. AH's login page has a captcha that only works on AH's own website, so the code has to come from your browser:

You need a computer for this, not a phone or tablet: their browsers have no developer console. Chrome, Edge or Brave work best.

1. **Open the link** your assistant gives you, but don't log in yet.
2. **Open the developer console** in that tab, a panel for web developers that you can open safely: <kbd>⌘</kbd> <kbd>⌥</kbd> <kbd>J</kbd> on Mac, or <kbd>Ctrl</kbd> <kbd>Shift</kbd> <kbd>J</kbd> on Windows and Linux.
3. **Log in** as usual. AH then tries to open its phone app, which your browser can't do, so the page seems stuck. In the console, find this red line:

   ```
   Failed to launch 'appie://login-exit?code=…' because the scheme does not have a registered handler.
   ```

4. **Copy the part from `appie://` up to the closing quote** and paste it into the chat. The code works once and expires quickly, so paste it right away.

No line there? See [Troubleshooting](#troubleshooting). To log a server in without the developer console, see [Running it on a server](#running-it-on-a-server).

<details>
<summary><b>Where your login is stored</b></summary>

Your login is saved on your own computer and renewed automatically, in a file only your user can read:

| OS | Location |
|---|---|
| macOS | `~/Library/Application Support/albert-heijn-mcp/tokens.json` |
| Linux | `~/.config/albert-heijn-mcp/tokens.json` (or under `$XDG_CONFIG_HOME`) |
| Windows | `%AppData%\albert-heijn-mcp\tokens.json` |

Override the location with `AH_TOKENS_PATH`.
</details>

## Troubleshooting

<details>
<summary><b>No login window opens</b></summary>

The login window needs Chrome, Edge, Brave or Chromium installed in the usual place, and a screen: not over SSH, and not with Ubuntu's snap Chromium. Without one, your assistant gives you the link instead, and you [copy the code by hand](#logging-in). If the window closed before you finished, ask to log in again.
</details>

<details>
<summary><b>No "Failed to launch" line after logging in</b></summary>

The developer console has to be open before you log in. Open it, then open the login link again in that same tab and log in. If AH skips the login form because you're still logged in, that's fine: the line appears all the same. You can also look for the `appie://login-exit?code=…` request in the Network tab. Browsers other than Chrome, Edge or Brave may show the link in an error page or dialog instead.
</details>

<details>
<summary><b>Login fails with "exchange code"</b></summary>

Codes work once and expire quickly. Ask to log in again and paste the new link straight away.
</details>

<details>
<summary><b>"Not logged in", or the session seems broken</b></summary>

Ask your assistant to log you out and back in, or delete `tokens.json` from the [login location](#logging-in) and log in again.
</details>

<details>
<summary><b>"The Albert Heijn login has expired"</b></summary>

Albert Heijn no longer accepts the stored login. Ask your assistant to log in to Albert Heijn again. Reconnecting your app to the server doesn't help: that's a separate login.

If it keeps expiring on your server, keep `tokens.json` on storage that survives restarts and redeploys, and run a single instance. AH replaces the login every time it's renewed, so an older copy of the file, or a second instance renewing on its own, gets rejected.
</details>

<details>
<summary><b>"Already connected as …" when pasting a login code</b></summary>

A code never replaces a working login, so a code from someone else's account can't switch you over. To switch accounts, ask to log out first, then log in again.
</details>

<details>
<summary><b>"There is no active delivery order to change"</b></summary>

AH accepts order changes only once an order exists. Choose a delivery slot in the AH app or on ah.nl first.
</details>

<details>
<summary><b>"The shopping list is not available while a delivery order is active"</b></summary>

Choosing a slot moved your list into the order. Ask your assistant to change the order instead (`ah_get_cart`, `ah_update_cart_item`) until it is delivered or cancelled.
</details>

<details>
<summary><b>The server doesn't start: "needs AH_MCP_TOKEN of at least 32 characters"</b></summary>

Set `AH_MCP_TOKEN` to a long random value, e.g. the output of `openssl rand -hex 32`, and restart. Changing it logs out every client; reconnect them once.
</details>

<details>
<summary><b>Server login page shows "This login link is not valid"</b></summary>

Start connecting again from the app. If it keeps happening right after you enter the token, check that `AH_MCP_BASE_URL` is exactly the address in your browser, including `https://`: the login form is only accepted from that address.
</details>

<details>
<summary><b>Server login opens at localhost, or the app can't reach it</b></summary>

Set `AH_MCP_BASE_URL` to the server's public `https://` URL and restart it. Apps are sent there to log in.
</details>

<details>
<summary><b>Port 3000 is in use</b></summary>

Set `AH_MCP_PORT` to another port, in the environment or `.env`.
</details>

---

## Running it on a server

Web and mobile apps such as ChatGPT and Claude.ai need the server on the internet, over Streamable HTTP with HTTPS. The endpoint is `https://your-server/mcp`.

Apps log in with OAuth: add the endpoint with OAuth (or automatic) authentication, and the app opens a login page on your server. Enter your `AH_MCP_TOKEN` there once; the app then gets its own tokens and renews them. The server accepts only these OAuth tokens, not `AH_MCP_TOKEN` itself, so apps without OAuth support can't connect over HTTP; run them [locally](#other-apps) instead.

> [!IMPORTANT]
> Anyone with `AH_MCP_TOKEN` can log in and use your Albert Heijn account. Use a long random value (`openssl rand -hex 32`). Changing it logs out every client.

It runs as a hardened systemd service behind a reverse proxy, installed from npm:

1. **Prepare the server.** Install Node.js 24 and create a service user:

   ```bash
   sudo useradd -r -m -d /home/albert-heijn-mcp -s /sbin/nologin albert-heijn-mcp
   ```

2. **Configure it** in `/home/albert-heijn-mcp/.env`:

   ```env
   AH_MCP_BASE_URL=https://albert-heijn-mcp.example.com
   AH_MCP_TOKEN=<output of: openssl rand -hex 32>
   ```

   Make it readable only by the service: `sudo chown albert-heijn-mcp: /home/albert-heijn-mcp/.env && sudo chmod 600 /home/albert-heijn-mcp/.env`.

3. **Install it** with the [service unit](deploy/albert-heijn-mcp.service) that comes with the package (it runs in `--remote` mode):

   ```bash
   sudo npm install --global --prefix /usr/local --ignore-scripts albert-heijn-mcp
   sudo install -m 644 /usr/local/lib/node_modules/albert-heijn-mcp/deploy/albert-heijn-mcp.service /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl enable --now albert-heijn-mcp
   ```

   To update, run the same commands, then `sudo systemctl restart albert-heijn-mcp`.

4. **Add TLS** with a reverse proxy that forwards to `127.0.0.1:3000`. With Caddy:

   ```
   albert-heijn-mcp.example.com {
       reverse_proxy 127.0.0.1:3000
   }
   ```

To log the server in to Albert Heijn, ask a connected app to log you in and [copy the code by hand](#logging-in). Or skip the code: log in on your own computer with the login window, then copy the login to the server:

```bash
AH_TOKENS_PATH=./server-tokens.json npx -y albert-heijn-mcp login
scp server-tokens.json your-server:ah-tokens.json && rm server-tokens.json
ssh -t your-server 'sudo sh -c "install -d -o albert-heijn-mcp -g albert-heijn-mcp -m 700 /home/albert-heijn-mcp/.config/albert-heijn-mcp && install -o albert-heijn-mcp -g albert-heijn-mcp -m 600 $HOME/ah-tokens.json /home/albert-heijn-mcp/.config/albert-heijn-mcp/tokens.json.new && mv /home/albert-heijn-mcp/.config/albert-heijn-mcp/tokens.json.new /home/albert-heijn-mcp/.config/albert-heijn-mcp/tokens.json && rm $HOME/ah-tokens.json"'
```

The server picks it up on the next request; no restart needed. The separate file keeps your computer's own login apart: AH replaces a login every time it's renewed, so only one place can use each login. On a host without SSH, upload it to where the server keeps its login: `AH_TOKENS_PATH`, or the [default location](#logging-in) for the user it runs as.

The service can write only to `/home/albert-heijn-mcp`, where it keeps its tokens. If you point `AH_LOG_FILE` elsewhere, add that path to `ReadWritePaths` in the unit file.

## Configuration

Settings are environment variables. They can also go in a `.env` file in the working directory (see [`.env.example`](.env.example)); variables already set in the environment take precedence. On a hosting platform, set them in its environment variable or secret settings instead of a `.env` file, so `AH_MCP_TOKEN` stays out of the app's files.

| Variable | Default | Description |
|---|---|---|
| `AH_REMOTE` | `false` | Don't open a browser on login; log in by copying the code instead (same as `--remote`). Always on with `streamable-http`. |
| `AH_TOKENS_PATH` | [per OS](#logging-in) | Where to store login tokens. |
| `AH_MCP_HOST` | `127.0.0.1` | Interface the HTTP server listens on. Keep the default behind a reverse proxy. |
| `AH_MCP_PORT` | `3000` | HTTP server port. |
| `AH_MCP_BASE_URL` | `http://localhost:3000` | Public URL of the HTTP server. Set it on a server: OAuth clients are sent to this URL to log in, and for a non-local URL the localhost-only `Host` check is turned off so a reverse proxy can forward requests. |
| `AH_MCP_TOKEN` | — | Secret for the HTTP transport, at least 32 characters; the transport doesn't start without it. You enter it on the OAuth login page; it also signs the OAuth tokens. |
| `AH_LOG_FILE` | — | Also append logs to this file. Logs always go to stderr. |

Command-line flags:

```
node dist/index.js [--transport stdio|streamable-http] [--remote] [--version] [--help]
node dist/index.js login [--remote]
```

`stdio` (the default) is for local clients; `streamable-http` serves MCP at `/mcp`, with OAuth login at `/authorize`. `login` logs in to Albert Heijn from the terminal, saves the tokens and exits; with `--remote` it asks for the code instead of opening a login window.

## Tools

These are what your assistant uses behind the scenes; you don't call them yourself. Read-only tools are marked as such, so apps can run them without asking. Tools that remove data are marked destructive, so apps ask for confirmation first.

Tools that return data also return it as [structured output](https://modelcontextprotocol.io/specification/2025-06-18/server/tools#structured-content) with a declared schema, for clients that use it. Products and recipes in tool results include a `url` to their page on ah.nl, and the server asks the assistant to link their names to it.

<details>
<summary><b>Account</b></summary>

| Tool | Description |
|---|---|
| `ah_login` | Log in: opens a login window on your computer, or returns AH's login link and completes the login with the code you paste back. |
| `ah_logout` | Delete the stored tokens, to switch accounts or reset a session. |
| `ah_get_member_profile` | Name, masked email, bonus card number (last 4 digits), and your savings: koopzegels (stamps, and what they're worth with interest) and Air Miles. |

</details>

<details>
<summary><b>Products & offers</b></summary>

| Tool | Description |
|---|---|
| `ah_search_products` | Search one or more keywords at once; Dutch terms work best. Filter by `bonus=true` or by `filters` (organic, vegan, gluten_free and other diets, allergens and labels), and `sort` by price, what you buy most, or Nutri-Score. `category_id` limits it to one category, or lists the category on its own. |
| `ah_get_products` | Details for one or more products, by product ID or by `barcodes` (the number under a barcode). `include_nutritional_info=true` adds the nutrition table. |
| `ah_get_categories` | AH's top-level product categories, or a category's subcategories with their product counts, for `category_id` in `ah_search_products`. |
| `ah_get_product_alternatives` | Similar products and substitutes AH suggests for a product. |
| `ah_get_bonus_offers` | This week's bonus offers, or next week's with `period=next`. `previously_bought=true` limits them to products you bought before (AH's "Eerder gekocht"). Can filter by keyword. |
| `ah_get_bonus_group_products` | The individual products behind a group deal such as "2+1 gratis". |
| `ah_get_personal_offers` | Your personal offers (Bonus Box): which are activated, which you can still activate, and how many you may activate this week. |
| `ah_activate_personal_offer` | Activate personal offers you choose. AH limits activations per week and they can't be undone. |
| `ah_search_stores` | Nearby stores, by postal code or your own address. |
| `ah_get_last_chance_items` | Vandaag-af markdowns in a store; the one nearest your address by default. |

</details>

<details>
<summary><b>Recipes</b></summary>

| Tool | Description |
|---|---|
| `ah_search_recipes` | Search Allerhande recipes; Dutch terms work best. `filters` narrows by diet, course, cuisine, occasion, season or cooking method (e.g. `vegetarian`, `quick`, `italian`), and works without a query too; `sort` orders by relevance, newest or popular. |
| `ah_get_recipe` | Ingredients, steps, and nutrition per serving. `servings` scales the ingredients. |
| `ah_get_meal_plan` | What's planned in the AH app's weekplanner for the next two weeks: recipes, products and notes. |
| `ah_add_recipe_to_shopping_list` | Match a recipe's ingredients to products and add them to the list in one step. It prefers products on bonus (`prefer_bonus=false` turns that off); `skip` leaves out what you have, and `dry_run=true` previews the matches. |

</details>

<details>
<summary><b>Shopping list & favourites</b></summary>

| Tool | Description |
|---|---|
| `ah_get_shopping_list` | Your shopping list ("Mijn lijst"), the basket you fill while shopping. |
| `ah_add_to_shopping_list` | Put products on the list, with a quantity each. |
| `ah_add_free_text_to_shopping_list` | Add a free-text item, like "verse bloemen". |
| `ah_remove_from_shopping_list` | Remove products or free-text items. |
| `ah_clear_shopping_list` | Remove everything. Requires `confirm="yes"`. |
| `ah_get_favorite_lists` | Your favourite lists ("Mijn lijstjes"). |
| `ah_add_to_favorite_list` | Add products to a favourite list. |
| `ah_remove_from_favorite_list` | Take products off a favourite list. |
| `ah_create_favorite_list` | Start a new, empty favourite list. |
| `ah_delete_favorite_list` | Delete a favourite list and its items. Requires `confirm="yes"`. |

</details>

<details>
<summary><b>Delivery order</b></summary>

Choosing a delivery or pick-up slot in the AH app moves your shopping list into an order. `ah_get_delivery_slots` shows when delivery is possible; the other tools work on that order.

| Tool | Description |
|---|---|
| `ah_get_delivery_slots` | Delivery windows at your address for the coming days. |
| `ah_get_cart` | Products in the active order, with total price and discount. |
| `ah_update_cart_item` | Change a product's quantity; 0 takes it out. |
| `ah_remove_from_cart` | Remove a product from the order. |
| `ah_clear_cart` | Remove everything from the order. Requires `confirm="yes"`. |

</details>

<details>
<summary><b>Orders & receipts</b></summary>

| Tool | Description |
|---|---|
| `ah_get_orders` | Upcoming delivery orders, or past ones with `past=true`. |
| `ah_get_order_details` | Products in one order. |
| `ah_get_frequent_items` | The products you buy most, counted over your delivery orders and in-store receipts of the last few months (`months`, default 3). `source` limits it to `online` or `in_store`. |
| `ah_get_receipts` | Recent in-store receipts (kassabonnen). |
| `ah_get_receipt_details` | Items, deposit, discounts, koopzegels bought and payment for one receipt, with its total. |

</details>

### Limitations

- **Delivery orders can't be started through the API.** `ah_get_delivery_slots` lists the windows, but booking one, which starts the order, happens in the AH app or on ah.nl. While the order is active, AH doesn't serve the shopping list; the tools say so and point to the order tools.
- **Ticking off shopping-list items isn't supported:** the API returns no usable item IDs.
- **Recipes can't be planned in the meal planner:** `ah_get_meal_plan` reads it, but AH's API refuses to add recipes, so planning happens in the AH app.
- **Limits per call:** at most 99 of a product, 50 items, 100 characters for a free-text item or list name, and details for 20 products.

## Development

```bash
git clone https://github.com/olekpuchka/albert-heijn-mcp
cd albert-heijn-mcp
npm ci
npm run build    # compile to dist/
npm run lint     # type-check
```

Run it from the checkout with `node dist/index.js`, or use `/path/to/albert-heijn-mcp/dist/index.js` as the argument in your client's config with `node` as the command.

| Path | Contents |
|---|---|
| [`src/index.ts`](src/index.ts), [`src/config.ts`](src/config.ts), [`src/loginCommand.ts`](src/loginCommand.ts) | Entry point, flags and settings, and the `login` command |
| [`src/ahapi/`](src/ahapi) | Client for AH's REST and GraphQL API, on Node's built-in `fetch` |
| [`src/auth/`](src/auth) | Login window, login code exchange, token storage and refresh |
| [`src/server/`](src/server) | Streamable HTTP transport and OAuth login |
| [`src/tools/`](src/tools) | The MCP tools, one file per area |
| [`deploy/`](deploy) | systemd unit, shipped in the package |
| [`manifest.json`](manifest.json), [`.mcpbignore`](.mcpbignore) | Manifest of the `.mcpb` bundle, and the files it leaves out |
| [`listing/`](listing) | Name, descriptions and icon to use in connector settings and app directories ([how](listing/README.md)) |
| [`.github/`](.github) | CI, release workflow, Dependabot and the pinned `mcp-publisher` install |
| [`assets/`](assets) | Logo for this README and the server icon shown by MCP clients |

The only runtime dependencies are the official [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk) and Zod, which the SDK uses for tool schemas.

To call tools by hand, use the [MCP Inspector](https://github.com/modelcontextprotocol/inspector):

```bash
npx @modelcontextprotocol/inspector node dist/index.js
```

Before deploying a change, run a quick check against a real account: log in, search for `melk`, add a product to your shopping list and remove it again, then view your cart and orders.

To release, set the new version with `npm version 1.2.3 --no-git-tag-version` and in both places in [`server.json`](server.json) and in [`manifest.json`](manifest.json), merge it to `main`, and push a tag: `git tag v1.2.3 && git push origin v1.2.3`. Only repository admins can create `v*` tags. The [release workflow](.github/workflows/release.yml) checks that the versions match, builds the package, attaches it to the GitHub release as `albert-heijn-mcp.tgz` together with the `albert-heijn-mcp.mcpb` bundle, and stages the package on npm through [trusted publishing](https://docs.npmjs.com/trusted-publishers), so no npm token is stored. Approve the staged version on npmjs.com (or with `npm stage approve`) to make it live; the workflow then updates the [MCP Registry](https://registry.modelcontextprotocol.io) entry. The release starts without notes; write them on GitHub.

## License

[Apache 2.0](LICENSE)
