# Commercial licence for tyo-mq

`tyo-mq` (the broker/server in this repository) is licensed under the
**GNU Affero General Public License v3.0 or later (AGPL-3.0-or-later)** — see
[`LICENSE`](./LICENSE).

The AGPL is a strong copyleft licence. In particular, its **network-use clause
(section 13)** means that if you run a *modified* version of the broker as a
network service, you must offer the complete corresponding source code of that
version to the users who interact with it over the network. Running the
**unmodified** broker, or using it internally, does not trigger that
obligation — but any modification you deploy as a service does.

## What does *not* need a commercial licence

- **The client and the wire protocol are permissive (Apache-2.0).**
  [`tyo-mq-client`](https://www.npmjs.com/package/tyo-mq-client) and
  [`tyo-mq-protocol`](https://www.npmjs.com/package/tyo-mq-protocol) are
  Apache-2.0. Building an application against tyo-mq — using the client in your
  own code, proprietary or not — needs **no** commercial licence and carries
  **no** AGPL obligations. This is the case for the vast majority of users.
- **Running the unmodified broker** for your own use, or self-hosting the open
  broker and complying with the AGPL.

## When you might want a commercial licence

A commercial licence is for organisations that cannot meet the AGPL's
obligations on the **broker** — for example, if you want to:

- run a **modified** tyo-mq broker inside a proprietary or closed-source product
  or SaaS without publishing your changes,
- embed or redistribute the broker as part of a proprietary offering, or
- otherwise use the broker under terms incompatible with the AGPL.

A commercial licence grants use of the tyo-mq broker without the AGPL's
copyleft / network-source obligations, under mutually agreed terms.

## Getting a commercial licence

Commercial licences are offered by TYO. To discuss terms, contact:

**eric@tyo.com.au**

Please include a short description of your intended use so we can suggest the
right terms.
