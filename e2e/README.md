# Product E2E

Browser-level verification that the pinned service combination actually works together.
Each suite is a Node test (`e2e/<name>.test.mjs`) run by `npm run test:e2e`:

- install, build and start the pinned front/back, then drive the product's public UI;
- assert requests, responses, DOM and console errors against the approved contracts;
- own temporary data and clean up the whole process group in `finally`.

An HTML fetch or a direct API call is not browser verification. The tool's own screen
regression suite lives in `tests-ui/` and is not product evidence.
