import json, sys
P = []
def r(a, b): P.append((a, b))
r("""colorEngine(): ColorEngine                    // the stub until then: { id: 'none', available: false }""",
  """colorEngine(): ColorEngine                    // the stub until then: id 'none', available false, decodeConversion 'default',
                                              // adoptOnOpen nothing, displaySpace 'srgb', transform identity, parse null,
                                              // builtins and profiles [SRGB]""")
r("""| CMYK, Lab, Multichannel (channel views) | `doc.profile` is RGB; a tagged CMYK or Lab file is converted to the working RGB space on open by icc-engine (better than 0.3's naive formula; the CMYK profile is not kept: real CMYK is 0.10) |""",
  """| CMYK, Lab, Multichannel (channel views) | `doc.profile` is RGB; a tagged CMYK or Lab file opens as 0.3 converts it (the readers convert before the profile is seen) and an open notice says its profile was not used; profile-based conversion is color-settings' (0.6), real CMYK 0.10 |""")
r("""`edit:assign-profile` (Don't Color Manage / Working RGB /
Profile; one entry), CMYK and Lab files converted on open, `describe`,""",
  """`edit:assign-profile` (Don't Color Manage / Working RGB /
Profile; one entry), `describe`,""")
json.dump(P, open(sys.argv[1], 'w'))
