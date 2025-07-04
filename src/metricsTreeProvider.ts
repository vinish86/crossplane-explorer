import * as vscode from 'vscode';
import { exec, spawn, ChildProcessWithoutNullStreams } from 'child_process';

export class CrossplaneMetricsTreeProvider implements vscode.TreeDataProvider<MetricItem> {
  private _onDidChangeTreeData: vscode.EventEmitter<MetricItem | undefined | void> = new vscode.EventEmitter<MetricItem | undefined | void>();
  readonly onDidChangeTreeData: vscode.Event<MetricItem | undefined | void> = this._onDidChangeTreeData.event;

  private metrics: MetricItem[] = [];
  private crossplaneMetrics: string = '';
  private clusterMetrics: string = '';
  private crossplaneProc: ChildProcessWithoutNullStreams | null = null;
  private clusterProc: ChildProcessWithoutNullStreams | null = null;
  private clusterInterval: NodeJS.Timeout | null = null;
  private crossplaneInterval: NodeJS.Timeout | null = null;
  private monitorTimeout: NodeJS.Timeout | null = null;
  private selectedDuration: number | null = null;
  private monitorEndTime: number | null = null;
  private remainingTimeInterval: NodeJS.Timeout | null = null;

  constructor() {}

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  setMonitorDuration(minutes: number) {
    this.selectedDuration = minutes;
    this.stopCrossplaneMetrics();
    this.stopClusterMetrics();
    if (this.monitorTimeout) {
      clearTimeout(this.monitorTimeout);
      this.monitorTimeout = null;
    }
    if (this.remainingTimeInterval) {
      clearInterval(this.remainingTimeInterval);
      this.remainingTimeInterval = null;
    }
    this.monitorEndTime = Date.now() + minutes * 60 * 1000;
    this.startCrossplaneMetrics();
    this.startClusterMetrics();
    this.monitorTimeout = setTimeout(() => {
      this.stopCrossplaneMetrics();
      this.stopClusterMetrics();
      vscode.window.showInformationMessage(`Performance monitoring stopped after ${minutes} minutes.`);
      this.selectedDuration = null;
      this.monitorEndTime = null;
      if (this.remainingTimeInterval) {
        clearInterval(this.remainingTimeInterval);
        this.remainingTimeInterval = null;
      }
      this.refresh();
    }, minutes * 60 * 1000);
    // Start interval to update remaining time every second
    this.remainingTimeInterval = setInterval(() => {
      this.refresh();
    }, 1000);
    this.refresh();
  }

  // Called by the process handlers
  updateCrossplaneMetrics(data: string) {
    this.crossplaneMetrics = data;
    this.refresh();
  }

  updateClusterMetrics(data: string) {
    this.clusterMetrics = data;
    this.refresh();
  }

  startCrossplaneMetrics() {
    if (this.crossplaneInterval) return;
    this.runCrossplaneMetrics();
    this.crossplaneInterval = setInterval(() => {
      this.runCrossplaneMetrics();
    }, 5000);
  }

  runCrossplaneMetrics() {
    const proc = spawn('crossplane', ['beta', 'top', '-s']);
    let buffer = '';
    proc.stdout.on('data', data => {
      buffer += data.toString();
    });
    proc.stdout.on('end', () => {
      this.updateCrossplaneMetrics(buffer);
    });
    proc.stderr.on('data', data => {
      // Optionally handle errors
    });
    proc.on('close', () => {
      // No action needed
    });
  }

  stopCrossplaneMetrics() {
    if (this.crossplaneInterval) {
      clearInterval(this.crossplaneInterval);
      this.crossplaneInterval = null;
    }
  }

  startClusterMetrics() {
    if (this.clusterInterval) return;
    this.runClusterMetrics();
    this.clusterInterval = setInterval(() => {
      this.runClusterMetrics();
    }, 5000);
  }

  runClusterMetrics() {
    const proc = spawn('kubectl', ['top', 'nodes']);
    let buffer = '';
    proc.stdout.on('data', data => {
      buffer += data.toString();
    });
    proc.stdout.on('end', () => {
      this.updateClusterMetrics(buffer);
    });
    proc.stderr.on('data', data => {
      // Optionally handle errors
    });
    proc.on('close', () => {
      // No action needed
    });
  }

  stopClusterMetrics() {
    if (this.clusterInterval) {
      clearInterval(this.clusterInterval);
      this.clusterInterval = null;
    }
  }

  stopMonitoring() {
    this.stopCrossplaneMetrics();
    this.stopClusterMetrics();
    if (this.monitorTimeout) {
      clearTimeout(this.monitorTimeout);
      this.monitorTimeout = null;
    }
    if (this.remainingTimeInterval) {
      clearInterval(this.remainingTimeInterval);
      this.remainingTimeInterval = null;
    }
    this.selectedDuration = null;
    this.monitorEndTime = null;
    vscode.window.showInformationMessage('Performance monitoring stopped.');
    this.refresh();
  }

  getTreeItem(element: MetricItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: MetricItem): Promise<MetricItem[]> {
    if (!element) {
      // Add monitor duration selector at the top
      const items: MetricItem[] = [];
      const monitorSelector = new MetricItem('Monitor for: 1 min   5 min   15 min   30 min', vscode.TreeItemCollapsibleState.None);
      monitorSelector.command = {
        command: 'crossplane-metrics.setMonitorDuration',
        title: 'Set Monitor Duration',
        arguments: [this]
      };
      monitorSelector.iconPath = new vscode.ThemeIcon('watch');
      if (this.selectedDuration && this.monitorEndTime) {
        // Calculate remaining time
        const msLeft = this.monitorEndTime - Date.now();
        const min = Math.max(0, Math.floor(msLeft / 60000));
        const sec = Math.max(0, Math.floor((msLeft % 60000) / 1000));
        monitorSelector.description = `Active: ${min} min ${sec} sec left`;
        // Add Stop Monitoring button
        const stopItem = new MetricItem('Stop Monitoring', vscode.TreeItemCollapsibleState.None);
        stopItem.command = {
          command: 'crossplane-metrics.stopMonitoring',
          title: 'Stop Monitoring',
          arguments: [this]
        };
        stopItem.iconPath = new vscode.ThemeIcon('debug-stop');
        items.push(stopItem);
      } else {
        monitorSelector.description = 'Inactive';
      }
      items.push(monitorSelector);
      return [...items, ...parseMetrics(this.crossplaneMetrics)];
    }
    if (element.label === 'Cluster') {
      // Only show metrics if monitoring is active
      if (!(this.selectedDuration && this.monitorEndTime)) {
        return [];
      }
      if (!this.clusterMetrics.trim()) {
        this.startClusterMetrics();
        return [];
      }
      return parseClusterMetrics(this.clusterMetrics);
    }
    if (element.label === 'Crossplane') {
      // Only show metrics if monitoring is active
      if (!(this.selectedDuration && this.monitorEndTime)) {
        return [];
      }
      if (!this.crossplaneMetrics.trim()) {
        this.startCrossplaneMetrics();
        return [];
      }
      return parseMetrics(this.crossplaneMetrics)[0].children || [];
    }
    return element.children || [];
  }
}

export class MetricItem extends vscode.TreeItem {
  children?: MetricItem[];
  constructor(
    label: string,
    collapsibleState: vscode.TreeItemCollapsibleState,
    children?: MetricItem[]
  ) {
    super(label, collapsibleState);
    this.children = children;
  }
}

function parseMetrics(output: string): MetricItem[] {
  const iconBase = require('path').join(__dirname, '..', 'resources');
  const lines = output.trim().split('\n');
  const pods = lines[0]?.split(':')[1]?.trim() || '-';
  const crossplane = lines[1]?.split(':')[1]?.trim() || '-';
  const func = lines[2]?.split(':')[1]?.trim() || '-';
  const provider = lines[3]?.split(':')[1]?.trim() || '-';
  const memory = lines[4]?.split(':')[1]?.trim() || '-';
  const cpu = lines[5]?.split(':')[1]?.trim() || '-';

  // Compose two horizontal summary lines for Crossplane
  const summaryLine1 = `Pods: ${pods}   Crossplane: ${crossplane}   Function: ${func}   Providers: ${provider}`;
  const summaryLine2 = `Memory: ${memory}   CPU: ${cpu}`;

  const crossplaneSummary = [
    (() => { const i = new MetricItem(summaryLine1, vscode.TreeItemCollapsibleState.None); i.iconPath = new vscode.ThemeIcon('preview'); return i; })(),
    (() => { const i = new MetricItem(summaryLine2, vscode.TreeItemCollapsibleState.None); i.iconPath = new vscode.ThemeIcon('chip'); return i; })(),
  ];

  // Parse pod table for Crossplane
  const tableStart = lines.findIndex(l => l.startsWith('TYPE'));
  const crossplanePods: MetricItem[] = [];
  const functionPods: MetricItem[] = [];
  const providerPods: MetricItem[] = [];

  for (let i = tableStart + 1; i < lines.length; i++) {
    const l = lines[i].trim();
    if (!l) continue;
    // TYPE   NAMESPACE   NAME   CPU   MEMORY
    const [type, namespace, ...rest] = l.split(/\s+/);
    let fullName = rest.slice(0, rest.length - 2).join(' ');
    const cpu = rest[rest.length - 2];
    const mem = rest[rest.length - 1];
    // Hide hash in pod name (show only base name before last dash and hash)
    let displayName = fullName.replace(/-[a-z0-9]{6,}$/i, '');
    // Truncate to first 40 characters if too long
    if (displayName.length > 40) {
      displayName = displayName.slice(0, 40) + '...';
    }
    const podItem = new MetricItem(displayName, vscode.TreeItemCollapsibleState.None);
    podItem.description = `${cpu} | ${mem}`;
    podItem.tooltip = `Pod: ${fullName}\nNamespace: ${namespace}\nCPU: ${cpu}\nMemory: ${mem}`;
    podItem.iconPath = new vscode.ThemeIcon('symbol-field');
    if (type === 'crossplane') crossplanePods.push(podItem);
    else if (type === 'function') functionPods.push(podItem);
    else if (type === 'provider') providerPods.push(podItem);
  }

  // Group nodes with icons for Crossplane
  const crossplaneNode = new MetricItem(`Crossplane (${crossplanePods.length})`, vscode.TreeItemCollapsibleState.Collapsed, crossplanePods);
  crossplaneNode.iconPath = {
    light: vscode.Uri.file(require('path').join(iconBase, 'ice-cream-stick-light.svg')),
    dark: vscode.Uri.file(require('path').join(iconBase, 'ice-cream-stick-dark.svg'))
  };
  const functionNode = new MetricItem(`Function (${functionPods.length})`, vscode.TreeItemCollapsibleState.Collapsed, functionPods);
  functionNode.iconPath = new vscode.ThemeIcon('symbol-function');
  const providerNode = new MetricItem(`Providers (${providerPods.length})`, vscode.TreeItemCollapsibleState.Collapsed, providerPods);
  providerNode.iconPath = new vscode.ThemeIcon('plug');

  const podsNode = new MetricItem('Pods', vscode.TreeItemCollapsibleState.Expanded, [
    crossplaneNode,
    functionNode,
    providerNode,
  ]);
  podsNode.iconPath = new vscode.ThemeIcon('package');

  // Crossplane root node
  const crossplaneSummaryNode = new MetricItem('Crossplane', vscode.TreeItemCollapsibleState.Collapsed, [
    ...crossplaneSummary,
    podsNode
  ]);
  crossplaneSummaryNode.iconPath = {
    light: vscode.Uri.file(require('path').join(iconBase, 'ice-cream-stick-light.svg')),
    dark: vscode.Uri.file(require('path').join(iconBase, 'ice-cream-stick-dark.svg'))
  };

  // --- Cluster Node ---
  const clusterIconBase = require('path').join(__dirname, '..', 'resources');
  const clusterNode = new MetricItem('Cluster', vscode.TreeItemCollapsibleState.Collapsed);
  clusterNode.iconPath = {
    light: vscode.Uri.file(require('path').join(clusterIconBase, 'cluster-light.svg')),
    dark: vscode.Uri.file(require('path').join(clusterIconBase, 'cluster-dark.svg'))
  };
  clusterNode.children = parseClusterMetrics(output);

  // Return both nodes at the root
  return [
    crossplaneSummaryNode,
    clusterNode
  ];
}

function parseClusterMetrics(output: string): MetricItem[] {
  const lines = output.trim().split('\n');
  if (lines.length < 2) return [];
  const [header, ...nodeLines] = lines;
  // Example header: NAME   CPU(cores)   CPU%   MEMORY(bytes)   MEMORY%
  // Example node: lima-rancher-desktop   129m   6%   3162Mi   80%
  const summaryLine = nodeLines.map(l => {
    const [name, cpu, cpuPct, mem, memPct] = l.split(/\s+/);
    return `Node: ${name}   CPU: ${cpu} (${cpuPct})   Memory: ${mem} (${memPct})`;
  }).join(' | ');
  return [
    (() => { const i = new MetricItem(summaryLine, vscode.TreeItemCollapsibleState.None); i.iconPath = new vscode.ThemeIcon('preview'); return i; })(),
  ];
}

// Register the command in your extension activation (in extension.ts):
// context.subscriptions.push(vscode.commands.registerCommand('crossplane-metrics.setMonitorDuration', async (provider: CrossplaneMetricsTreeProvider) => {
//   const pick = await vscode.window.showQuickPick(['5', '15', '30'], { placeHolder: 'Select monitoring duration (minutes)' });
//   if (pick) provider.setMonitorDuration(Number(pick));
// })); 