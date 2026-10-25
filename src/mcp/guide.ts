export const SPEC_REFERENCE = `View spec (JSON):
{
  "name": "order-to-shipping",            // kebab-case, also the file name
  "title": "How an order reaches shipping",
  "question": "<the user's question, verbatim>",
  "include": [ <selector>, ... ],          // required
  "exclude": [ <selector>, ... ],
  "edges": ["triggers","calls","produces","consumes","uses"],   // also: injects, extends
  "groupBy": ["module","class"],           // any of module | package | lane | class, outermost first
  "groups": [{ "id": "checkout", "label": "Checkout", "members": [<selector>] }],  // custom grouping
  "detail": "medium",                      // low | medium | high
  "annotations": { "<id>": { "label": "...", "note": "...", "emphasis": "highlight" | "muted" } },
  "notes": [{ "text": "markdown", "attach": "<id>" }],
  "direction": "RIGHT",                    // or DOWN
  "maxNodes": 80
}
Selectors:
- an id from search/get: "type:demo.orders.domain.OrderService", "method:demo.orders.domain.OrderService#place(String,List)",
  "entry:OrderController.create", "topic:orders.v1", "ext:db:sql"; "*" globs work inside ids: "type:demo.orders.api.*"
- "kind:type|method|entry|topic|external", "role:inbound|service|outbound|model|config|http|kafka|schedule|...",
  "module:orders-service", "package:demo.orders.**" (* = one segment, ** = any), "name:*Order*"
- {"reachable": {"from": <selector or list>, "depth": 4, "via": ["triggers","calls","produces","consumes","uses"], "both": false}}
- {"methodsOf": <selector>}, {"all": [<selector>, ...]} (intersection), {"any": [...]} (union)
Hidden endpoints are lifted: a call between hidden methods is drawn between their shown classes.
Colors, icons, node text and layout come from the project theme; you cannot set them.`;

export const DESIGN_GUIDE = `You are designing a JSON Canvas diagram of a Java codebase with the java-canvas tools.
The canvas must look and read like every other canvas in this project, and stay stable over time.

1. Call find_view with the question. If a saved view answers it (or nearly), get_view it and change it with
   update_view. Do not create a second view for the same question: updating keeps node positions, so the user
   sees a clean diff.
2. Otherwise call project_summary, then search / get / neighbors / trace to find the real ids involved.
   Use source only when you need to understand behaviour for a label or note.
3. Write the spec with selectors rather than long id lists ("reachable" from an entry point, "package:", "role:"),
   so the view keeps working when code is added. Only reference ids returned by the tools; never invent ids.
4. Keep it readable: aim for 8-40 nodes. Prefer groupBy ["module","class"] for flows, ["lane"] for architecture.
   Use exclude to drop noise (DTOs, config, accessors). Use annotations and notes sparingly for insight the
   code does not state.
5. Run create_view (or update_view) with dry_run first, check the node list, then run it for real.
6. Tell the user the canvas path, and summarise what is shown and, on updates, what changed.

${SPEC_REFERENCE}`;
