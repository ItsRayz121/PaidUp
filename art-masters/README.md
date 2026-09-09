# Art masters — source renders, NEVER shipped

Full-resolution masters for the app's illustrations. Everything under
`web/public/` is served to every visitor, so a 1.5 MB master left in there
is 1.5 MB one `git add .` away from being downloaded by real users on mobile
data. They live here instead.

The shipped copies are WebP re-encodes in `web/public/`. To regenerate one
(there is no image-generation tool in this workspace — see
`~/.claude/memory/no-image-generation-mcp.md`; `sharp` in `api/` can only
resize and re-encode what already exists):

    node -e '
    const sharp = require("./api/node_modules/sharp");
    sharp("art-masters/mine-hero-v2.png").webp({ quality: 88 })
      .toFile("web/public/brand/mine-hero-v2.webp");
    '

q88 is the floor: below it the dark gradients in these renders band visibly.
Alpha is preserved losslessly at any quality (sharp defaults alphaQuality:100).

Masters are gitignored — keep a copy off this machine too.
