/** 平台可配置的模型工具；编排与展示机制不属于业务工具开关。 */
export const RUNTIME_TOOL_CATALOG = Object.freeze([
  {
    name: "exec_command",
    label: "执行命令",
    description: "在沙箱中执行命令；命令仍可读写文件。",
    group: "文件与命令",
  },
  { name: "read", label: "读取文件", description: "读取沙箱文件及图片。", group: "文件与命令" },
  { name: "edit", label: "编辑文件", description: "按匹配内容修改沙箱文件。", group: "文件与命令" },
  { name: "write", label: "写入文件", description: "创建或覆盖沙箱文件。", group: "文件与命令" },
  {
    name: "skill",
    label: "加载技能",
    description: "加载已固定版本的技能说明。",
    group: "任务与交付",
  },
  {
    name: "todo_write",
    label: "更新任务清单",
    description: "维护当前任务的执行清单。",
    group: "任务与交付",
  },
  {
    name: "deliver_file",
    label: "交付文件",
    description: "将沙箱文件发布为用户可下载的附件。",
    group: "任务与交付",
  },
  {
    name: "automation_update",
    label: "管理定时任务",
    description: "创建、修改或取消定时任务。",
    group: "任务与交付",
  },
  {
    name: "spawn_agent",
    label: "创建子智能体",
    description: "启动受工具委派范围约束的子任务。",
    group: "智能体协作",
  },
  {
    name: "send_message",
    label: "发送消息",
    description: "向已有子智能体发送消息。",
    group: "智能体协作",
  },
  {
    name: "followup_task",
    label: "追加子任务",
    description: "为已有子智能体追加任务。",
    group: "智能体协作",
  },
  {
    name: "wait_agent",
    label: "等待子智能体",
    description: "等待并读取子任务的进展。",
    group: "智能体协作",
  },
  {
    name: "interrupt_agent",
    label: "中断子智能体",
    description: "请求停止正在执行的子任务。",
    group: "智能体协作",
  },
  {
    name: "list_agents",
    label: "列出子智能体",
    description: "查看当前 Run 的子任务。",
    group: "智能体协作",
  },
] as const);

export type RuntimeToolName = (typeof RUNTIME_TOOL_CATALOG)[number]["name"];
export const RUNTIME_TOOL_NAMES: readonly RuntimeToolName[] = Object.freeze(
  RUNTIME_TOOL_CATALOG.map((tool) => tool.name),
);

/** 缺省保留旧配置的全工具行为；显式空清单关闭所有业务工具。非法值失败关闭。 */
export function normalizeRuntimeToolSelection(
  value: unknown,
): readonly RuntimeToolName[] | undefined {
  if (value === undefined) return undefined;
  if (
    !Array.isArray(value) ||
    value.length > RUNTIME_TOOL_NAMES.length ||
    [...value].some(
      (name) => typeof name !== "string" || !RUNTIME_TOOL_NAMES.includes(name as RuntimeToolName),
    ) ||
    new Set(value).size !== value.length
  )
    throw new TypeError("启用工具必须是无重复的已知工具名称清单");
  return Object.freeze(RUNTIME_TOOL_NAMES.filter((name) => value.includes(name)));
}
