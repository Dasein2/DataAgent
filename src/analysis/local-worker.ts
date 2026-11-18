import { ResultStore } from "../results/store.js";
import { localSqlInProcess } from "./results.js";
process.once("message", async (input: any) => {
  try {
    const result = await localSqlInProcess(
      new ResultStore(input.root),
      input.meta,
      input.sql,
      input.limits,
      input.options,
    );
    process.send?.({ result });
  } catch (error: any) {
    process.send?.({
      error: {
        code: error.code,
        message: error.message,
        details: error.details,
      },
    });
  }
});
