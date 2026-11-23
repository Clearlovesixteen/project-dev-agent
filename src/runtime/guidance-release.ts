/** 维护者可以单独回退指引输出。任务归属、源码和验收检查仍照常执行。 */
export function guidanceEnabled() { return process.env.PROJECT_DEV_GUIDANCE !== "off"; }
