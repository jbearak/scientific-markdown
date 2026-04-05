* Build test fixture for embedded .dta table tests
* Run from the test/fixtures/tables/ directory

clear
input str12 Fruit byte Season str8 Color
"Apple"    1 "Red"
"Mango"    2 "Orange"
"Strawberry" 3 "Red"
""         .a ""
end

* Define value labels for Season
label define season_lbl 1 "Autumn" 2 "Summer" 3 "Spring"
label values Season season_lbl

* Also label the .a extended missing value
label define season_lbl .a "Refused", add

* Variable labels
label variable Fruit "Fruit name"
label variable Season "Growing season"
label variable Color "Primary color"

save "embed.dta", replace
