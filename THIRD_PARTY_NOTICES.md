# Third-party notices

jev-hooks is released under the MIT License (see [`LICENSE`](LICENSE)). It includes
material derived from the project below, which keeps its own license and notice.

## jev-claude-code

- Project: [DarioFontanel/jev-claude-code](https://github.com/DarioFontanel/jev-claude-code),
  by Dario Fontanel
- License: MIT
- Material in this repository: `tests/data/checks-original.json`, the Italian question
  set this project started from. It was generated with that project's code-review
  prompt (`prompts/03-code-review.md`): its 14 question ids, their types and the four
  lanes come from the prompt, and some of its question texts are the prompt's own. The
  ids and lanes of `config/checks.json` and `config/policy.json` descend from it; their
  question texts were rewritten and measured on this project's bench.

The upstream license:

```
MIT License

Copyright (c) Dario Fontanel

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
