import { main } from "../../src/main";

await main({
  afterMount() {
    setTimeout(() => {
      throw new Error("injected fatal error after terminal takeover");
    }, 100);
  },
});
