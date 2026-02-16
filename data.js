const WORKOUTS = [
  {
    id: "push1",
    name: "PUSH 1",
    color: "#e53935",
    icon: "chest",
    warmup: [
      { order: "A", name: "5-10 min warm up on assault bike", sets: "x1", tempo: "steady", rest: "-" },
      { order: "B", name: "Chest Stretch", sets: "2x 30 sec", tempo: "control", rest: "-" },
      { order: "C", name: "Banded shoulder drill", sets: "2x 30 sec", tempo: "control", rest: "-" },
      { order: "D", name: "Standing Cable Face Pulls", sets: "2x 12-15", tempo: "control", rest: "-" }
    ],
    exercises: [
      { order: "A", name: "Standing Cable Fly (top Cable)", setsConfig: "2 x 10-12, 1 x 15-20", tempo: "3011", rest: "1-2 mins", notes: "Find the sweet spot for squeezing your chest at lock out, hit the same spot on every rep" },
      { order: "B", name: "Smith Machine Incline Press", setsConfig: "2x 8-10, 1x 12-15", tempo: "3111", rest: "1-2 mins", notes: "Lock in your upper back and push through the chest through the set" },
      { order: "C", name: "Floor Db Press", setsConfig: "3x 12-15", tempo: "3011", rest: "1-2 mins", notes: "Lock in your upper back. Start every rep from a dead stop and think and squeezing your elbows together not pushing the dumbbell" },
      { order: "D", name: "Lean Away Lateral Raises", setsConfig: "2 x 10-12 each arm", tempo: "3011", rest: "1-2 mins", notes: "Control the negative, big squeeze at the top of each rep" },
      { order: "E", name: "Rear Delt Pec Dec", setsConfig: "3 x 10-15", tempo: "3111", rest: "45s", notes: "Keep the tension on your rear delts throughout" },
      { order: "F", name: "Cable Reverse Grip Ez Bar Pressdowns", setsConfig: "Pump Set + 3 x 8-12", tempo: "3011", rest: "45s", notes: "Grip tighter through your thumb part of your hand. Pump set = 15-25 reps to warm up" },
      { order: "G", name: "Long Rope Pressdowns", setsConfig: "3 x 10-15", tempo: "3111", rest: "45s", notes: "Controlled reps throughout the set" }
    ]
  },
  {
    id: "pull1",
    name: "PULL 1",
    color: "#1e88e5",
    icon: "back",
    warmup: [
      { order: "A", name: "5-10 min warm up on the rower", sets: "x1", tempo: "steady", rest: "-" },
      { order: "B", name: "Lumbar rolls", sets: "2x 1min", tempo: "control", rest: "-" },
      { order: "C", name: "Deadbugs", sets: "2 x10", tempo: "control", rest: "-" },
      { order: "D", name: "Standing Cable Face Pulls", sets: "2x10", tempo: "control", rest: "-" }
    ],
    exercises: [
      { order: "A", name: "Cable Lat Pull Down Pronated Wide Grip", setsConfig: "2 x 6-8, 1 x 8-12", tempo: "3111", rest: "1-2 min", notes: "Use straps and keep tension on lats" },
      { order: "B", name: "Pull Up / Chin Up", setsConfig: "3x 6-10", tempo: "3111", rest: "ALAN", notes: "Use an underhand grip. Add weight if you can exceed the rep range" },
      { order: "C", name: "Chest Supported Dual Dumbbell Row", setsConfig: "2 x 10-12", tempo: "3010", rest: "1-2 min", notes: "Keep chest tight to the pad. Go heavy and get the full range of motion" },
      { order: "D", name: "Plate Loaded Low Row - Neutral", setsConfig: "1 x 8-10, 1 x 12-15", tempo: "3111", rest: "1-2 mins", notes: "Use straps and keep tension on lats" },
      { order: "E", name: "Single Arm Bent Over Dumbbell Row", setsConfig: "1 x 8-10, 1 x 15-20", tempo: "3111", rest: "60s", notes: "Keep your core locked in hard. Don't create momentum through the core" },
      { order: "F", name: "Ez Bar Preacher Curl", setsConfig: "Pump Set + 3 x 8-12", tempo: "3011", rest: "45s", notes: "Squeeze hard at the top. Pump set = 15-25 reps to warm up" },
      { order: "G", name: "Low Cable Dual Bicep Curl", setsConfig: "3 x 10-15", tempo: "3111", rest: "45s", notes: "Make your biceps burn" }
    ]
  },
  {
    id: "legs1",
    name: "LEGS 1",
    color: "#43a047",
    icon: "legs",
    warmup: [
      { order: "A", name: "5-10 min warm up on the bike", sets: "1x", tempo: "steady", rest: "-" },
      { order: "B", name: "Lumbar rolls", sets: "2x 30 sec", tempo: "control", rest: "-" },
      { order: "C", name: "Plank", sets: "2x 45 sec", tempo: "control", rest: "-" },
      { order: "D", name: "Banded Back Walk", sets: "2x 45 sec", tempo: "control", rest: "-" }
    ],
    exercises: [
      { order: "A", name: "Single Leg Extension", setsConfig: "2 x 8-10, 1 x 15-20", tempo: "3111", rest: "1-2 mins", notes: "Weakest leg first and match the reps on your stronger leg" },
      { order: "B", name: "Pendulum", setsConfig: "1 x 6-8, 1 x 10-12, 1 x 15-20", tempo: "3010", rest: "ALAN", notes: "Feet low and close for quads" },
      { order: "C", name: "Leg Press", setsConfig: "3x 10-15", tempo: "3111", rest: "1-2 min", notes: "Keep your feet high on the plate" },
      { order: "D", name: "Hamstring Curl", setsConfig: "1 x 6-8, 2 x 10-12", tempo: "4011", rest: "1-2 min", notes: "Keep hips tight to the bench" },
      { order: "E", name: "Back Extensions - Glute Focus", setsConfig: "2 x 10-15", tempo: "3010", rest: "1-2 mins", notes: "Focus on your glutes" },
      { order: "F", name: "Ab Wheel Roll Out", setsConfig: "3x10", tempo: "4111", rest: "1-2mins", notes: "Tuck the pelvis and tense trunk" }
    ]
  },
  {
    id: "push2",
    name: "PUSH 2",
    color: "#e53935",
    icon: "chest",
    warmup: [
      { order: "A", name: "5-10 min warm up on assault bike", sets: "x1", tempo: "steady", rest: "-" },
      { order: "B", name: "Chest Stretch", sets: "2x 30 sec", tempo: "control", rest: "-" },
      { order: "C", name: "Banded shoulder drill", sets: "2x 30 sec", tempo: "control", rest: "-" },
      { order: "D", name: "Standing Cable Face Pulls", sets: "2x 12-15", tempo: "control", rest: "-" }
    ],
    exercises: [
      { order: "A", name: "Crucifix Lateral Raise - Seated", setsConfig: "3 x 10-15", tempo: "3111", rest: "1-2 mins", notes: "Control the load" },
      { order: "B", name: "Smith Machine Shoulder - Standard", setsConfig: "1 x 15-20, 2 x 8-10", tempo: "3010", rest: "1-2 mins", notes: "Lower to below your chin" },
      { order: "C", name: "Fly To Press", setsConfig: "2 x 8-10, 1 x 10-12", tempo: "3111", rest: "1-2 mins", notes: "Set the bench at a 15 degree incline" },
      { order: "D", name: "Seated Db Side Raises", setsConfig: "2 x 10-15", tempo: "3111", rest: "1-2mins", notes: "Or you can lean into an upright bench and support your chest" },
      { order: "E", name: "Upright Row - Ez Bar - Cable", setsConfig: "3 x 10-12", tempo: "3111", rest: "60s", notes: "Focus on elbows high" },
      { order: "F", name: "Short Rope Pressdowns", setsConfig: "Pump Set + 3 x 8-12", tempo: "3011", rest: "45s", notes: "Keep elbows locked by your sides" },
      { order: "G", name: "Low Cable Overhead Tricep Extensions", setsConfig: "3 x 10-15", tempo: "3111", rest: "45s", notes: "Focus on the stretched position" }
    ]
  },
  {
    id: "pull2",
    name: "PULL 2",
    color: "#1e88e5",
    icon: "back",
    warmup: [
      { order: "A", name: "5-10 min warm up on the rower", sets: "x1", tempo: "steady", rest: "-" },
      { order: "B", name: "Lumbar rolls", sets: "2x 1min", tempo: "control", rest: "-" },
      { order: "C", name: "Deadbugs", sets: "2 x10", tempo: "control", rest: "-" },
      { order: "D", name: "Standing Cable Face Pulls", sets: "2x10", tempo: "control", rest: "-" }
    ],
    exercises: [
      { order: "A", name: "Barbell Bent Over Row", setsConfig: "2 x 6-8, 1 x 8-12", tempo: "3011", rest: "2-3mins", notes: "Use a overhand grip with straps" },
      { order: "B", name: "Single Arm High Row - Plate Loaded", setsConfig: "2 x 6-8, 1 x 12-15", tempo: "3011", rest: "2-3 mins", notes: "Single arm rows - weakest arm first" },
      { order: "C", name: "Seated Low Cable Row - Close Neutral Grip", setsConfig: "1 x 6-9, 2 x 10-12", tempo: "3011", rest: "2-3 mins", notes: "Do not lean back too far. Drag the handle towards your belly button" },
      { order: "D", name: "Cable Lat Pull Down Supinated Grip", setsConfig: "2 x 8-10, 1 x 12-15", tempo: "3011", rest: "1-2 mins", notes: "Use straps and keep tension on lats" },
      { order: "E", name: "Single Arm Low Row - Cable", setsConfig: "1 x 8-10, 1 x 15-20", tempo: "3111", rest: "60s", notes: "Big squeeze in the lower lat on every rep" },
      { order: "F", name: "Db Spider Curl", setsConfig: "Pump Set + 3 x 8-10", tempo: "3011", rest: "45s", notes: "Squeeze hard at the top. Pump set = 15-25 reps to warm up" },
      { order: "G", name: "Ez Bar Bicep Curl", setsConfig: "3 x 10-15", tempo: "2111", rest: "45s", notes: "Reverse grip instead of palms up" }
    ]
  },
  {
    id: "legs2",
    name: "LEGS 2",
    color: "#43a047",
    icon: "legs",
    warmup: [
      { order: "A", name: "5-10 min warm up on the bike", sets: "1x", tempo: "steady", rest: "-" },
      { order: "B", name: "Lumbar rolls", sets: "2x 30 sec", tempo: "control", rest: "-" },
      { order: "C", name: "Plank", sets: "2x 45 sec", tempo: "control", rest: "-" },
      { order: "D", name: "Banded Back Walk", sets: "2x 45 sec", tempo: "control", rest: "-" }
    ],
    exercises: [
      { order: "A", name: "Bulgarian Split Squat", setsConfig: "3 x 8-12", tempo: "3010", rest: "-", notes: "Hold one DB in opposite hand to your forward leg" },
      { order: "B", name: "Hack Squat", setsConfig: "2 x 8-10, 1 x 12-15", tempo: "3010", rest: "-", notes: "Or smith machine with heels raised - setup for quad dominance" },
      { order: "C", name: "Barbell Hip Thrust", setsConfig: "2 x 8-10, 1 x 12-15", tempo: "2111", rest: "-", notes: "Keep your chin tucked down and your abs engaged" },
      { order: "D", name: "Leg Extension", setsConfig: "2 x 12-15, 1 x 15-20", tempo: "3111", rest: "-", notes: "Grip on the seat tight!" },
      { order: "E", name: "Walking Lunges", setsConfig: "2 x 12-15 each leg", tempo: "3010", rest: "1-2 mins", notes: "Use dumbbells" },
      { order: "F", name: "Floor Crunch", setsConfig: "3x20", tempo: "control", rest: "1min", notes: "Tense hard" }
    ]
  }
];
