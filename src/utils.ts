import * as cp from 'child_process';

export function executeCommand(cmd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
        const child = cp.spawn(cmd, args);

        let stdout = '';
        let stderr = '';

        child.stdout.on('data', (data) => {
            stdout += data.toString();
        });

        child.stderr.on('data', (data) => {
            stderr += data.toString();
        });

        child.on('close', (code) => {
            if (code !== 0) {
                const commandString = `${cmd} ${args.join(' ')}`;
                reject(new Error(stderr || `Command failed with code ${code} for command: ${commandString}`));
            } else {
                resolve({ stdout, stderr });
            }
        });

        child.on('error', (err) => {
            reject(err);
        });
    });
}

export function executeCommandWithStdin(cmd: string, args: string[], stdinContent: string): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
        const child = cp.spawn(cmd, args);

        let stdout = '';
        let stderr = '';

        child.stdout.on('data', (data) => {
            stdout += data.toString();
        });

        child.stderr.on('data', (data) => {
            stderr += data.toString();
        });

        child.on('close', (code) => {
            if (code !== 0) {
                const commandString = `${cmd} ${args.join(' ')}`;
                reject(new Error(stderr || `Command failed with code ${code} for command: ${commandString}`));
            } else {
                resolve({ stdout, stderr });
            }
        });

        child.on('error', (err) => {
            reject(err);
        });
        
        child.stdin.write(stdinContent);
        child.stdin.end();
    });
} 