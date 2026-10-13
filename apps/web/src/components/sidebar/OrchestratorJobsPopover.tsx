import type { OrchestratorJob } from "@t3tools/contracts";
import { WorkflowIcon, RefreshCwIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useActiveEnvironmentId, useProjects } from "~/state/entities";
import { useEnvironments, usePrimaryEnvironmentId } from "~/state/environments";
import { projectEnvironment } from "~/state/projects";
import { useEnvironmentQuery } from "~/state/query";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { SidebarMenuButton, SidebarMenuItem } from "../ui/sidebar";

const SECTIONS = [
  { category: "running", label: "Active jobs" },
  { category: "review", label: "Awaiting review" },
  { category: "failed", label: "Needs attention" },
  { category: "completed", label: "Recent completed" },
] as const;

function JobRow({ job, projectName }: { job: OrchestratorJob; projectName: string }) {
  return (
    <details className="rounded-md border border-border/50 px-2 py-1.5">
      <summary className="cursor-pointer text-xs">
        <span className="font-medium">{job.id}</span>
        <span className="ml-2 text-muted-foreground">{job.phase.replaceAll("_", " ")}</span>
        <span className="mt-1 block truncate text-muted-foreground">
          {projectName}
          {job.model ? ` · ${job.model}` : ""}
        </span>
      </summary>
      <div className="mt-2 space-y-1 break-words text-xs text-muted-foreground">
        {job.task ? <p>{job.task}</p> : null}
        {job.branch ? <p>Branch: {job.branch}</p> : null}
        {job.worktree ? <p>Worktree: {job.worktree}</p> : null}
        <p>Updated: {new Date(job.updatedAt).toLocaleString()}</p>
        <p>State: {job.statePath}</p>
      </div>
    </details>
  );
}

export function OrchestratorJobsPopover() {
  const [open, setOpen] = useState(false);
  const projects = useProjects();
  const activeEnvironmentId = useActiveEnvironmentId();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const { environments } = useEnvironments();
  const [chosenEnvironmentId, setChosenEnvironmentId] = useState<string | null>(null);
  const environmentId =
    environments.find((environment) => environment.environmentId === chosenEnvironmentId)
      ?.environmentId ??
    activeEnvironmentId ??
    primaryEnvironmentId;
  const scopedProjects = useMemo(
    () => projects.filter((project) => project.environmentId === environmentId),
    [projects, environmentId],
  );
  const cwds = useMemo(
    () => [...new Set(scopedProjects.map((project) => project.workspaceRoot))].sort().slice(0, 50),
    [scopedProjects],
  );
  const query = useEnvironmentQuery(
    open && environmentId
      ? projectEnvironment.orchestratorJobs({ environmentId, input: { cwds } })
      : null,
  );
  const { refresh } = query;
  useEffect(() => {
    if (!open || !environmentId) return;
    refresh();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") refresh();
    }, 5_000);
    return () => window.clearInterval(timer);
  }, [open, environmentId, refresh]);
  const jobs = query.data?.jobs ?? [];

  return (
    <SidebarMenuItem className="shrink-0">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          openOnHover
          delay={250}
          closeDelay={250}
          render={
            <SidebarMenuButton size="icon" aria-label="Orchestrator jobs">
              <WorkflowIcon />
            </SidebarMenuButton>
          }
        />
        <PopoverPopup side="top" align="start" width="lg" padding="compact">
          <div className="mb-2 flex items-center justify-between gap-2">
            <h2 className="text-sm font-medium">Orchestrator jobs</h2>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Refresh orchestrator jobs"
              onClick={refresh}
              disabled={query.isPending || !environmentId}
            >
              <RefreshCwIcon className="size-3.5" />
            </Button>
          </div>
          {environments.length > 1 ? (
            <select
              className="mb-2 w-full rounded-md border border-border bg-background px-2 py-1 text-xs"
              aria-label="Jobs environment"
              value={environmentId ?? ""}
              onChange={(event) => setChosenEnvironmentId(event.target.value)}
            >
              {environments.map((environment) => (
                <option key={environment.environmentId} value={environment.environmentId}>
                  {environment.label}
                </option>
              ))}
            </select>
          ) : null}
          <p className="mb-3 text-xs text-muted-foreground">
            Jobs across this machine. Updates every 5 seconds while open.
          </p>
          <div className="max-h-[min(60vh,28rem)] space-y-3 overflow-y-auto" aria-live="polite">
            {query.error ? (
              <p role="alert" className="text-xs text-destructive">
                {query.error}
              </p>
            ) : null}
            {query.isPending && !query.data ? (
              <p className="text-xs text-muted-foreground">Reading jobs…</p>
            ) : null}
            {!query.isPending && !query.error && jobs.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                No orchestration jobs found on this machine.
              </p>
            ) : null}
            {SECTIONS.map((section) => {
              const sectionJobs = jobs.filter((job) => job.category === section.category);
              const active = section.category === "running";
              if (!active && sectionJobs.length === 0) return null;
              const rows = (active ? sectionJobs : sectionJobs.slice(0, 5)).map((job) => (
                <JobRow
                  key={`${job.cwd}:${job.id}`}
                  job={job}
                  projectName={
                    scopedProjects.find((project) => project.workspaceRoot === job.cwd)?.title ??
                    job.cwd
                  }
                />
              ));
              return active ? (
                <section key={section.category} className="space-y-1.5">
                  <h3 className="text-xs font-medium">
                    {section.label} · {sectionJobs.length}
                  </h3>
                  {rows}
                  {sectionJobs.length === 0 && !query.isPending ? (
                    <p className="text-xs text-muted-foreground">
                      No running orchestration jobs detected.
                    </p>
                  ) : null}
                </section>
              ) : (
                <details key={section.category} className="space-y-1.5">
                  <summary className="cursor-pointer text-xs font-medium">
                    {section.label} · latest {Math.min(sectionJobs.length, 5)}
                  </summary>
                  {rows}
                </details>
              );
            })}
            {query.data?.skippedFiles ? (
              <p className="text-xs text-muted-foreground">
                {query.data.skippedFiles} unreadable or incomplete state files skipped.
              </p>
            ) : null}
            {query.data?.discoveryWarning ? (
              <p role="alert" className="text-xs text-muted-foreground">
                {query.data.discoveryWarning}
              </p>
            ) : null}
            {query.data?.truncated || scopedProjects.length > 50 ? (
              <p className="text-xs text-muted-foreground">
                Results are limited to keep the monitor responsive.
              </p>
            ) : null}
          </div>
        </PopoverPopup>
      </Popover>
    </SidebarMenuItem>
  );
}
