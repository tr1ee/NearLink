#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <shellapi.h>
#include <wchar.h>
#include <stdio.h>
#include <string.h>

/* A GUI-subsystem bootstrap may be detached from Electron. PowerShell must
 * instead have its own hidden console: DETACHED_PROCESS can exit before any
 * script executes, with exit code zero and no redirected diagnostic output. */
static void log_text(HANDLE log, const char *text) {
  DWORD written;
  WriteFile(log, text, (DWORD)strlen(text), &written, NULL);
}
static void log_error(HANDLE log, const char *stage, DWORD code) {
  char line[160];
  snprintf(line, sizeof(line), "NearLink launcher: %s failed (Win32 %lu).\r\n", stage, (unsigned long)code);
  log_text(log, line);
}
static BOOL safe_path(const WCHAR *value) {
  return value && *value && !wcschr(value, L'"') && !wcschr(value, L'\r') && !wcschr(value, L'\n');
}
int WINAPI WinMain(HINSTANCE instance, HINSTANCE previous, LPSTR command, int show) {
  (void)instance; (void)previous; (void)command; (void)show;
  int argc = 0;
  WCHAR **argv = CommandLineToArgvW(GetCommandLineW(), &argc);
  if (!argv || argc != 5) return ERROR_INVALID_PARAMETER;
  for (int i = 1; i < argc; ++i) if (!safe_path(argv[i])) { LocalFree(argv); return ERROR_INVALID_PARAMETER; }
  SECURITY_ATTRIBUTES security = { sizeof(security), NULL, TRUE };
  HANDLE log = CreateFileW(argv[4], FILE_APPEND_DATA, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, &security, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
  if (log == INVALID_HANDLE_VALUE) { DWORD error = GetLastError(); LocalFree(argv); return (int)error; }
  log_text(log, "NearLink launcher: starting PowerShell with a new hidden console.\r\n");
  HANDLE input = CreateFileW(L"NUL", GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, &security, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
  if (input == INVALID_HANDLE_VALUE) { DWORD error = GetLastError(); log_error(log, "stdin", error); CloseHandle(log); LocalFree(argv); return (int)error; }
  size_t count = wcslen(argv[1]) + wcslen(argv[2]) + wcslen(argv[3]) + 160;
  if (count > 32767) { CloseHandle(input); CloseHandle(log); LocalFree(argv); return ERROR_FILENAME_EXCED_RANGE; }
  WCHAR *line = LocalAlloc(LPTR, count * sizeof(WCHAR));
  if (!line) { CloseHandle(input); CloseHandle(log); LocalFree(argv); return ERROR_NOT_ENOUGH_MEMORY; }
  swprintf(line, count, L"\"%ls\" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File \"%ls\" -RequestFile \"%ls\"", argv[1], argv[2], argv[3]);
  HANDLE job = CreateJobObjectW(NULL, NULL);
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits;
  ZeroMemory(&limits, sizeof(limits));
  /* Killing the bootstrap before readiness cancels PowerShell as well.
   * The installer and newly opened app must survive normal helper exit. */
  limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK;
  DWORD result = 0;
  if (!job || !SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits, sizeof(limits))) {
    result = GetLastError(); log_error(log, "job setup", result);
  } else {
    STARTUPINFOW startup;
    PROCESS_INFORMATION child;
    ZeroMemory(&startup, sizeof(startup)); ZeroMemory(&child, sizeof(child));
    startup.cb = sizeof(startup);
    startup.dwFlags = STARTF_USESHOWWINDOW | STARTF_USESTDHANDLES;
    startup.wShowWindow = SW_HIDE;
    startup.hStdInput = input; startup.hStdOutput = log; startup.hStdError = log;
    DWORD flags = CREATE_NEW_CONSOLE | CREATE_NEW_PROCESS_GROUP | CREATE_SUSPENDED;
    if (!CreateProcessW(argv[1], line, NULL, NULL, TRUE, flags, NULL, NULL, &startup, &child)) {
      result = GetLastError(); log_error(log, "CreateProcess", result);
    } else {
      if (!AssignProcessToJobObject(job, child.hProcess)) {
        result = GetLastError(); log_error(log, "job assignment", result); TerminateProcess(child.hProcess, result);
      } else if (ResumeThread(child.hThread) == (DWORD)-1) {
        result = GetLastError(); log_error(log, "ResumeThread", result); TerminateProcess(child.hProcess, result);
      } else {
        log_text(log, "NearLink launcher: PowerShell created; waiting for installer helper.\r\n");
        if (WaitForSingleObject(child.hProcess, INFINITE) != WAIT_OBJECT_0) result = GetLastError();
        else if (!GetExitCodeProcess(child.hProcess, &result)) result = GetLastError();
        char exit_line[96];
        snprintf(exit_line, sizeof(exit_line), "NearLink launcher: PowerShell exited with code %lu.\r\n", (unsigned long)result);
        log_text(log, exit_line);
      }
      CloseHandle(child.hThread); CloseHandle(child.hProcess);
    }
  }
  if (job) CloseHandle(job);
  CloseHandle(input); CloseHandle(log); LocalFree(line); LocalFree(argv);
  return (int)result;
}
