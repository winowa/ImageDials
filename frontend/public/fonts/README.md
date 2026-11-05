# Bundled fonts

Self-hosted WOFF2 subsets of three open-licensed families (SIL Open Font License 1.1). Served from `/fonts`; the application makes no remote font requests. License texts are in `licenses/` and must stay with the font files.

| Role               | Family                                                                                  | File                                        | Weights               | Axes kept        |
| ------------------ | --------------------------------------------------------------------------------------- | ------------------------------------------- | --------------------- | ---------------- |
| Display / headings | [Bricolage Grotesque](https://github.com/ateliertriay/bricolage)                        | `BricolageGrotesque-latin-700.woff2`        | 700 (static instance) | opsz fixed at 36 |
| Body / UI          | [Atkinson Hyperlegible Next](https://github.com/googlefonts/atkinson-hyperlegible-next) | `AtkinsonHyperlegibleNext-latin-wght.woff2` | 400-700 (variable)    | wght             |
| Technical / mono   | [JetBrains Mono](https://github.com/JetBrains/JetBrainsMono)                            | `JetBrainsMono-latin-wght.woff2`            | 400-700 (variable)    | wght             |

## Sources and licenses

| Family                     | Copyright                                                | Upstream source (variable TTF)                                                                                                                    | License text                                                                                                                               |
| -------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Bricolage Grotesque        | 2022 The Bricolage Grotesque Project Authors             | `fonts/variable/BricolageGrotesque[opsz,wdth,wght].ttf` at `ateliertriay/bricolage` commit `84745e5b96261ae5f8c6c856e262fe78d1d6efdd`             | [OFL.txt](https://github.com/ateliertriay/bricolage/blob/main/OFL.txt) (copy: `licenses/OFL-BricolageGrotesque.txt`)                       |
| Atkinson Hyperlegible Next | 2020-2024 The Atkinson Hyperlegible Next Project Authors | `fonts/variable/AtkinsonHyperlegibleNext[wght].ttf` at `googlefonts/atkinson-hyperlegible-next` commit `7925f50f649b3813257faf2f4c0b381011f434f1` | [OFL.txt](https://github.com/googlefonts/atkinson-hyperlegible-next/blob/main/OFL.txt) (copy: `licenses/OFL-AtkinsonHyperlegibleNext.txt`) |
| JetBrains Mono             | 2020 The JetBrains Mono Project Authors                  | `fonts/variable/JetBrainsMono[wght].ttf` in release `v2.304` of `JetBrains/JetBrainsMono` (commit `19371302b95d218af43299bce79ddbddd0bc364d`)     | [OFL.txt](https://github.com/JetBrains/JetBrainsMono/blob/master/OFL.txt) (copy: `licenses/OFL-JetBrainsMono.txt`)                         |

None of the three declares a Reserved Font Name, so the subsetted files keep their original family names. Also published at [Google Fonts: Bricolage Grotesque](https://fonts.google.com/specimen/Bricolage+Grotesque), [Google Fonts: Atkinson Hyperlegible Next](https://fonts.google.com/specimen/Atkinson+Hyperlegible+Next) and [JetBrains Mono](https://www.jetbrains.com/lp/mono/). License FAQ: <https://openfontlicense.org/>.

Upstream TTF SHA-256 (as downloaded):

- `BricolageGrotesque[opsz,wdth,wght].ttf`: `413e7357809ddd12fd80a96a8a396de0e401638d4acd3cb3e37532f0472ac682`
- `AtkinsonHyperlegibleNext[wght].ttf`: `5a455d1cfa099b601ab70751bb9673e8fe1854dc4500c80e1a220d0d75e31745`
- `JetBrainsMono[wght].ttf`: `662a196d58f1183bf2d77428b6d5283fe3f45161ab021bea4036bc98e5cac016`

## Modifications

Axis limiting, Latin subsetting (Basic Latin, Latin-1, common punctuation, arrows U+2190-2193, minus U+2212) and WOFF2 compression only; no outline changes. Rebuild with fonttools 4.68.0 and brotli 1.2.1, which are not project dependencies:

```text
SOURCE_DATE_EPOCH=1761868800 uv run --with fonttools==4.68.0 --with brotli==1.2.1 \
  python scripts/build_fonts.py --source <dir with the three upstream TTFs> --out frontend/public/fonts
```

The bundle is about 82 KB. Add new scripts as separate files (for example `-latin-ext`) with a matching `unicode-range` rather than widening the Latin files.
