import path from "path";
import { spawn } from "child_process";
import { getProjectRootDir, resolveScriptPath } from "./storageService.js";

export interface ScanMatch {
  name: string;
  confidence: string;
  path?: string;
}

export function runPythonScan(selfiePath: string, bulkDirPath: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const scriptPath = resolveScriptPath("scan_faces.py");
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

export function runPythonSelfieVector(selfiePath: string): Promise<Float32Array | null> {
  return new Promise((resolve) => {
    const scriptPath = resolveScriptPath("extract_selfie_vector.py");
    const py = spawn("python", [scriptPath, selfiePath]);
    let stdoutData = "";

    py.stdout.on("data", (data) => {
      stdoutData += data.toString();
    });

    py.on("close", (code) => {
      if (code === 0) {
        try {
          const lines = stdoutData.trim().split("\n");
          const lastLine = lines[lines.length - 1];
          const parsed = JSON.parse(lastLine);
          if (parsed.success && Array.isArray(parsed.vector)) {
            return resolve(new Float32Array(parsed.vector));
          }
        } catch (e) {}
      }
      resolve(null);
    });

    py.on("error", () => {
      resolve(null);
    });
  });
}
