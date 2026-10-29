/** 只用于非关键诊断；超时返回而不影响业务结果。后台文件操作仍自行收尾，不能用于业务写入。 */
export async function bestEffort(action: () => Promise<unknown>, budgetMs = 100): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([Promise.resolve().then(action).catch(() => {}),
      new Promise<void>(resolve => { timer = setTimeout(resolve, budgetMs); })]);
  } finally { if (timer) clearTimeout(timer); }
}
