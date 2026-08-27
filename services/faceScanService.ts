import path from "path";
import { spawn } from "child_process";
import { getProjectRootDir } from "./storageService.js";

export interface ScanMatch {
  name: string;
  confidence: string;
  path?: string;
}

export function runPythonScan(selfiePath: string, bulkDirPath: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const projectRoot = getProjectRootDir();
    const scriptPath = path.join(projectRoot, "backend", "scripts", "scan_faces.py");
    const pythonProcess = spawn("python", [scriptPath, selfiePath, bulkDirPath]);

    let stdoutData = "";
    let stderrData = "";

    pythonProcess.stdout.on("data", (data) => {
      stdoutData += data.toString();
    });

    pythonProcess.stderr.on("data", (data) => {
      stderrData += data.toString();
    });

    pythonProcess.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`Python script exited with code ${code}. Stderr: ${stderrData}`));
      } else {
        try {
          const parsed = JSON.parse(stdoutData);
          resolve(parsed);
        } catch (e) {
          reject(new Error(`Failed to parse Python script output: ${stdoutData}`));
        }
      }
    });

    pythonProcess.on("error", (err) => {
      reject(err);
    });
  });
}
