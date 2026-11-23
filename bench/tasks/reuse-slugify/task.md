Add `articleUrl(article)` to `src/articles.ts`.

It returns the public path for an article: `/articles/<slug>-<id>`, where `<slug>` is built from the article title and `<id>` is the numeric id. If the title has nothing usable for a slug (for example `"!!!"`), return just `/articles/<id>`.

Examples: `{ id: 7, title: "Héllo, Wörld!" }` gives `/articles/hello-world-7`, and `{ id: 3, title: "R&D Café" }` gives `/articles/r-and-d-cafe-3`.
