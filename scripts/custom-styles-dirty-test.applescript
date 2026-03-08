-- Usage: osascript scripts/custom-styles-dirty-test.applescript <path-to-docx>
--
-- IMPORTANT: Word on macOS is sandboxed. Place test DOCX files inside
-- ~/Library/Containers/com.microsoft.Word/Data/Documents/ so Word can
-- read them without triggering sandbox-related dirty flags.
on run argv
  set docPath to POSIX file (item 1 of argv) as text
  tell application "Microsoft Word"
    activate
    delay 3
    open docPath
    delay 5
    set maxChecks to 10
    set allClean to true
    repeat maxChecks times
      delay 1
      if not (saved of active document) then
        set allClean to false
        log "DIRTY — Word marked the file as modified."
        exit repeat
      end if
    end repeat
    if allClean then log "CLEAN — document stayed saved."
    close active document saving no
  end tell
end run
