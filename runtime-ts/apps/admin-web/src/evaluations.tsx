import type { EvaluationRunSummary, EvaluationSuite } from "@hoox/protocol";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, Button, Card, Input, Select, Space, Spin, Typography } from "antd";
import { useNavigate } from "react-router-dom";
import { useState } from "react";
import type { AdminControlApi } from "./control-api.js";
import type { AgentDefinitionApiContract } from "./control-api.js";

const emptySuite = (definitionId: string): EvaluationSuite => ({
  id: `eval_${crypto.randomUUID().replaceAll("-", "")}`,
  definitionId,
  name: "新评测集",
  description: "",
  cases: [
    {
      id: `case_${crypto.randomUUID().replaceAll("-", "")}`,
      name: "新用例",
      inputText: "",
      attachments: [],
      assertions: [{ kind: "text_contains", value: "" }],
    },
  ],
});

function assertionKey(
  assertions: EvaluationSuite["cases"][number]["assertions"],
  assertion: EvaluationSuite["cases"][number]["assertions"][number],
): string {
  const index = assertions.indexOf(assertion);
  const sameKindBefore = assertions
    .slice(0, index)
    .filter((item) => item.kind === assertion.kind).length;
  return `${assertion.kind}-${sameKindBefore}`;
}

export function EvaluationsPage({
  agents,
  api,
}: {
  readonly agents: AgentDefinitionApiContract;
  readonly api: AdminControlApi;
}) {
  const queryClient = useQueryClient();
  const [definitionId, setDefinitionId] = useState("");
  const [suite, setSuite] = useState<EvaluationSuite>();
  const definitions = useQuery({
    queryKey: ["admin-agent-definitions"],
    queryFn: () => agents.listAgentDefinitions(),
  });
  const suites = useQuery({
    queryKey: ["admin-evaluation-suites", definitionId],
    queryFn: () => api.listEvaluationSuites(definitionId),
    enabled: definitionId !== "",
  });
  const save = useMutation({
    mutationFn: (value: EvaluationSuite) => api.saveEvaluationSuite(value),
    onSuccess: async (_result, value) =>
      queryClient.invalidateQueries({ queryKey: ["admin-evaluation-suites", value.definitionId] }),
  });
  const agentsList = definitions.data?.items ?? [];
  if (definitions.isLoading) return <Spin aria-label="正在读取 Agent" />;
  if (definitions.isError) return <Alert type="error" title="读取 Agent 失败，请重试。" />;
  return (
    <Space direction="vertical" size="large" style={{ width: "100%" }}>
      <Typography.Paragraph>
        评测集用于验证同一 Agent 的不同
        Revision。每个用例包含输入和可视化断言；评测运行与结果对比可在此查看。模型评审和从真实
        Thread 导入尚未启用。
      </Typography.Paragraph>
      <Select
        aria-label="选择 Agent"
        placeholder="选择 Agent"
        style={{ width: "100%", maxWidth: 360 }}
        showSearch={{ optionFilterProp: "label" }}
        virtual={false}
        value={definitionId || undefined}
        options={agentsList.map(({ definition, revision }) => ({
          value: definition.id,
          label: `${revision?.displayName ?? definition.id}${definition.status === "draft" ? "（草稿）" : ""}`,
        }))}
        onChange={(value) => {
          setDefinitionId(value ?? "");
          setSuite(undefined);
        }}
      />
      {definitionId && (
        <>
          {suites.isLoading ? (
            <Spin />
          ) : suites.isError ? (
            <Alert type="error" title="评测集读取失败。" />
          ) : (
            <Space wrap>
              {(suites.data ?? []).map((item) => (
                <Button key={item.id} onClick={() => setSuite(item)}>
                  {item.name}
                </Button>
              ))}
              <Button type="primary" onClick={() => setSuite(emptySuite(definitionId))}>
                新建评测集
              </Button>
            </Space>
          )}
          {suite && (
            <EvaluationRunsPanel
              definitionId={definitionId}
              suite={suite}
              agents={agents}
              api={api}
            />
          )}
          {suite && (
            <Card title="评测集与用例">
              <Space direction="vertical" style={{ width: "100%" }}>
                <Input
                  aria-label="评测集名称"
                  value={suite.name}
                  onChange={(event) => setSuite({ ...suite, name: event.target.value })}
                />
                <Input.TextArea
                  aria-label="评测集用途说明"
                  value={suite.description}
                  onChange={(event) => setSuite({ ...suite, description: event.target.value })}
                />
                <Select
                  aria-label="评审模型"
                  allowClear
                  placeholder="选择评审模型（可选）"
                  value={
                    suite.reviewerModel === undefined
                      ? undefined
                      : JSON.stringify(suite.reviewerModel)
                  }
                  options={(definitions.data?.pinnedModelOptions ?? []).map((model) => ({
                    value: JSON.stringify(model),
                    label: `${model.providerKey} · ${model.modelId}`,
                  }))}
                  onChange={(value) => {
                    if (value === undefined) {
                      const {
                        reviewerModel: _model,
                        reviewerRubric: _rubric,
                        ...withoutReview
                      } = suite;
                      setSuite(withoutReview);
                      return;
                    }
                    const reviewerModel = definitions.data?.pinnedModelOptions.find(
                      (model) => JSON.stringify(model) === value,
                    );
                    if (reviewerModel) {
                      setSuite({
                        ...suite,
                        reviewerModel,
                        reviewerRubric: suite.reviewerRubric ?? "",
                      });
                    }
                  }}
                />
                {suite.reviewerModel && (
                  <Input.TextArea
                    aria-label="评分标准"
                    value={suite.reviewerRubric ?? ""}
                    onChange={(event) => setSuite({ ...suite, reviewerRubric: event.target.value })}
                  />
                )}
                {suite.cases.map((testCase, index) => (
                  <Card key={testCase.id} size="small" title={`用例 ${index + 1}`}>
                    <Space direction="vertical" style={{ width: "100%" }}>
                      <Input
                        aria-label="用例名称"
                        value={testCase.name}
                        onChange={(event) =>
                          setSuite({
                            ...suite,
                            cases: suite.cases.map((item, itemIndex) =>
                              itemIndex === index ? { ...item, name: event.target.value } : item,
                            ),
                          })
                        }
                      />
                      {suite.contentAccess === false ? (
                        <Typography.Text type="secondary">
                          无正文访问权限，输入与附件内容已隐藏
                        </Typography.Text>
                      ) : (
                        <Input.TextArea
                          aria-label="用户输入"
                          value={testCase.inputText}
                          onChange={(event) =>
                            setSuite({
                              ...suite,
                              cases: suite.cases.map((item, itemIndex) =>
                                itemIndex === index
                                  ? { ...item, inputText: event.target.value }
                                  : item,
                              ),
                            })
                          }
                        />
                      )}
                      {testCase.assertions.map((assertion, assertionIndex) => (
                        <Space
                          key={`${testCase.id}-${assertionKey(testCase.assertions, assertion)}`}
                        >
                          <Select
                            aria-label="断言类型"
                            value={assertion.kind}
                            options={[
                              { value: "text_contains", label: "回复包含文本" },
                              { value: "text_regex", label: "回复匹配正则" },
                              { value: "tool_called", label: "调用指定工具" },
                              { value: "artifact_exists", label: "产出 Artifact" },
                              { value: "model_score", label: "评审模型评分" },
                            ]}
                            onChange={(kind) =>
                              setSuite({
                                ...suite,
                                cases: suite.cases.map((item, itemIndex) =>
                                  itemIndex === index
                                    ? {
                                        ...item,
                                        assertions: item.assertions.map((entry, entryIndex) =>
                                          entryIndex === assertionIndex
                                            ? kind === "text_contains"
                                              ? { kind, value: "" }
                                              : kind === "text_regex"
                                                ? { kind, pattern: "" }
                                                : kind === "tool_called"
                                                  ? { kind, toolName: "" }
                                                  : kind === "artifact_exists"
                                                    ? { kind }
                                                    : { kind, minimumScore: 0.7 }
                                            : entry,
                                        ),
                                      }
                                    : item,
                                ),
                              })
                            }
                          />
                          <Input
                            aria-label="断言值"
                            value={
                              "value" in assertion
                                ? assertion.value
                                : "pattern" in assertion
                                  ? assertion.pattern
                                  : "toolName" in assertion
                                    ? assertion.toolName
                                    : assertion.kind === "model_score"
                                      ? String(assertion.minimumScore)
                                      : (assertion.name ?? "")
                            }
                            onChange={(event) =>
                              setSuite({
                                ...suite,
                                cases: suite.cases.map((item, itemIndex) =>
                                  itemIndex === index
                                    ? {
                                        ...item,
                                        assertions: item.assertions.map((entry, entryIndex) => {
                                          if (entryIndex !== assertionIndex) return entry;
                                          if (entry.kind === "text_contains")
                                            return { ...entry, value: event.target.value };
                                          if (entry.kind === "text_regex")
                                            return { ...entry, pattern: event.target.value };
                                          if (entry.kind === "tool_called")
                                            return { ...entry, toolName: event.target.value };
                                          if (entry.kind === "model_score")
                                            return {
                                              ...entry,
                                              minimumScore: Number(event.target.value),
                                            };
                                          return { ...entry, name: event.target.value };
                                        }),
                                      }
                                    : item,
                                ),
                              })
                            }
                          />
                        </Space>
                      ))}
                      <Button
                        onClick={() =>
                          setSuite({
                            ...suite,
                            cases: suite.cases.map((item, itemIndex) =>
                              itemIndex === index
                                ? {
                                    ...item,
                                    assertions: [
                                      ...item.assertions,
                                      { kind: "text_contains", value: "" },
                                    ],
                                  }
                                : item,
                            ),
                          })
                        }
                      >
                        添加断言
                      </Button>
                    </Space>
                  </Card>
                ))}
                <Space>
                  <Button
                    onClick={() =>
                      setSuite({
                        ...suite,
                        cases: [
                          ...suite.cases,
                          {
                            id: `case_${crypto.randomUUID().replaceAll("-", "")}`,
                            name: "新用例",
                            inputText: "",
                            attachments: [],
                            assertions: [],
                          },
                        ],
                      })
                    }
                  >
                    添加用例
                  </Button>
                  <Button
                    type="primary"
                    loading={save.isPending}
                    onClick={() => save.mutate(suite)}
                  >
                    保存评测集
                  </Button>
                </Space>
                {save.isError && <Alert type="error" title="评测集保存失败，请检查输入并重试。" />}
              </Space>
            </Card>
          )}
        </>
      )}
    </Space>
  );
}

function EvaluationRunsPanel({
  definitionId,
  suite,
  agents,
  api,
}: {
  readonly definitionId: string;
  readonly suite: EvaluationSuite;
  readonly agents: AgentDefinitionApiContract;
  readonly api: AdminControlApi;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [revisionId, setRevisionId] = useState<string>();
  const [concurrency, setConcurrency] = useState(1);
  const [selectedRunId, setSelectedRunId] = useState<string>();
  const [leftRunId, setLeftRunId] = useState<string>();
  const [rightRunId, setRightRunId] = useState<string>();
  const revisions = useQuery({
    queryKey: ["admin-agent-history", definitionId],
    queryFn: () => agents.listAgentRevisions(definitionId),
  });
  const runs = useQuery({
    queryKey: ["admin-evaluation-runs", definitionId],
    queryFn: () => api.listEvaluationRuns(definitionId),
    refetchInterval: 2_000,
  });
  const detail = useQuery({
    queryKey: ["admin-evaluation-run", definitionId, selectedRunId],
    queryFn: () => api.readEvaluationRun(definitionId, selectedRunId ?? ""),
    enabled: selectedRunId !== undefined,
    refetchInterval: (query) =>
      query.state.data && !["queued", "running"].includes(query.state.data.run.status)
        ? false
        : 2_000,
  });
  const start = useMutation({
    mutationFn: () =>
      api.startEvaluationRun(definitionId, suite.id, {
        id: `evaluation_${crypto.randomUUID().replaceAll("-", "")}`,
        revisionId: revisionId ?? "",
        maxConcurrency: concurrency,
      }),
    onSuccess: async (result) => {
      setSelectedRunId(result.id);
      await queryClient.invalidateQueries({ queryKey: ["admin-evaluation-runs", definitionId] });
    },
  });
  const cancel = useMutation({
    mutationFn: (runId: string) => api.cancelEvaluationRun(definitionId, runId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["admin-evaluation-runs", definitionId] });
      await queryClient.invalidateQueries({ queryKey: ["admin-evaluation-run", definitionId] });
    },
  });
  const comparison = useQuery({
    queryKey: ["admin-evaluation-compare", definitionId, leftRunId, rightRunId],
    queryFn: () => api.compareEvaluationRuns(definitionId, leftRunId ?? "", rightRunId ?? ""),
    enabled: Boolean(leftRunId && rightRunId && leftRunId !== rightRunId),
  });
  const runItems = runs.data ?? [];
  return (
    <Card title="批量评测与结果">
      <Space direction="vertical" style={{ width: "100%" }}>
        <Typography.Text type="secondary">
          在草稿或已发布 Revision 上运行用例；运行使用当前管理员的个人空间，不读取 Playground Mock。
        </Typography.Text>
        {revisions.isError && <Alert type="error" title="读取 Revision 失败。" />}
        <Space wrap>
          <Select
            aria-label="评测目标 Revision"
            placeholder="选择目标 Revision"
            value={revisionId}
            options={(revisions.data?.items ?? [])
              .filter((item) => item.status === "draft" || item.status === "published")
              .map((item) => ({ value: item.id, label: `版本 ${item.revision} · ${item.status}` }))}
            onChange={setRevisionId}
          />
          <Input
            aria-label="单次最大并发"
            type="number"
            min={1}
            max={32}
            value={concurrency}
            onChange={(event) =>
              setConcurrency(Math.max(1, Math.min(32, Number(event.target.value))))
            }
          />
          <Button
            type="primary"
            disabled={suite.contentAccess === false || !revisionId || suite.cases.length === 0}
            loading={start.isPending}
            onClick={() => start.mutate()}
          >
            发起评测
          </Button>
        </Space>
        {start.isError && <Alert type="error" title="评测启动失败。" />}
        {runs.isError ? (
          <Alert type="error" title="评测运行列表读取失败。" />
        ) : (
          <Space wrap>
            {runItems.map((item) => (
              <Button
                key={item.id}
                type={selectedRunId === item.id ? "primary" : "default"}
                onClick={() => setSelectedRunId(item.id)}
              >
                {item.revisionId} · {item.status} · {item.passedCases}/{item.totalCases}
              </Button>
            ))}
          </Space>
        )}
        {detail.isLoading && <Spin aria-label="正在读取评测结果" />}
        {detail.isError && <Alert type="error" title="评测结果读取失败。" />}
        {detail.data && (
          <>
            <Typography.Paragraph>
              通过率 {(detail.data.run.passRate * 100).toFixed(1)}%，通过{" "}
              {detail.data.run.passedCases}，失败 {detail.data.run.failedCases}，未知{" "}
              {detail.data.run.unknownCases}，取消 {detail.data.run.cancelledCases}
            </Typography.Paragraph>
            {detail.data.run.status === "queued" || detail.data.run.status === "running" ? (
              <Button danger onClick={() => cancel.mutate(detail.data.run.id)}>
                取消评测
              </Button>
            ) : null}
            {detail.data.results.map((result) => (
              <Card
                key={result.caseId}
                size="small"
                title={`${result.caseName} · ${{ queued: "排队中", running: "运行中", passed: "通过", failed: "失败", cancelled: "已取消", unknown: "未知" }[result.outcome]}`}
              >
                <Space direction="vertical">
                  {result.reason && <Typography.Text>{result.reason}</Typography.Text>}
                  {result.runId && result.tenantId && (
                    <Button
                      onClick={() =>
                        navigate(
                          `/runs/${encodeURIComponent(result.tenantId ?? "")}/${encodeURIComponent(result.runId ?? "")}`,
                        )
                      }
                    >
                      调试对应 Run
                    </Button>
                  )}
                </Space>
              </Card>
            ))}
          </>
        )}
        <Space wrap>
          <Select
            aria-label="对比左侧运行"
            placeholder="选择左侧运行"
            value={leftRunId}
            options={runItems.map(runOption)}
            onChange={setLeftRunId}
          />
          <Select
            aria-label="对比右侧运行"
            placeholder="选择右侧运行"
            value={rightRunId}
            options={runItems.map(runOption)}
            onChange={setRightRunId}
          />
        </Space>
        {comparison.data && (
          <>
            <Typography.Paragraph>
              通过率：{(comparison.data.leftPassRate * 100).toFixed(1)}% →{" "}
              {(comparison.data.rightPassRate * 100).toFixed(1)}%
            </Typography.Paragraph>
            {comparison.data.cases
              .filter((item) => item.changed)
              .map((item) => (
                <Typography.Text key={item.caseId}>
                  {item.caseName}：{item.leftOutcome ?? "无结果"} → {item.rightOutcome ?? "无结果"}
                </Typography.Text>
              ))}
          </>
        )}
      </Space>
    </Card>
  );
}

function runOption(run: EvaluationRunSummary) {
  return {
    value: run.id,
    label: `${run.revisionId} · ${run.status} · ${run.passedCases}/${run.totalCases}`,
  };
}
