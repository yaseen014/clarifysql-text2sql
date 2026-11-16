export interface BuiltinDatasetSeed {
  id: string;
  name: string;
  tableName: string;
  description: string;
  entityNoun: string;
  rows: Array<Record<string, string | number | null>>;
}

function generateStudentPerformanceRows(): Array<Record<string, string | number>> {
  const firstNames = [
    'Aarav', 'Maya', 'Liam', 'Sophia', 'Noah', 'Zara', 'Ethan', 'Priya', 'Lucas', 'Elena',
    'Mason', 'Ananya', 'Oliver', 'Chloe', 'Elijah', 'Nadia', 'Caleb', 'Hannah', 'Rohan', 'Isabella',
    'Julian', 'Meera', 'Owen', 'Leila', 'Daniel', 'Amara', 'Henry', 'Sana', 'Leo', 'Claire',
  ];
  const lastNames = [
    'Patel', 'Chen', 'OConnor', 'Rodriguez', 'Kim', 'AlMansoor', 'Wright', 'Nair', 'Bennett', 'Kowalski',
    'Brooks', 'Sharma', 'Foster', 'Rivera', 'Hughes', 'Hassan', 'Hayes', 'Morales', 'Verma', 'Rossi',
  ];
  const departments = [
    'Computer Science',
    'Data Science',
    'Mathematics',
    'Electrical Engineering',
    'Biotechnology',
  ];
  const genders = ['Female', 'Male', 'Non-binary'];
  const scholarships = ['Full', 'Partial', 'None'];

  const rows: Array<Record<string, string | number>> = [];
  for (let i = 0; i < 60; i++) {
    const first = firstNames[i % firstNames.length];
    const last = lastNames[(i * 7 + 3) % lastNames.length];
    const dept = departments[i % departments.length];
    const gender = genders[i % 11 === 0 ? 2 : i % 2];
    const age = 18 + ((i * 3 + 1) % 7); // 18..24
    const studyHours = 10 + ((i * 5) % 26); // 10..35
    const attendance = Number((72 + ((i * 4.3) % 27.5)).toFixed(1));
    const baseScore = 62 + ((i * 7 + (studyHours - 10)) % 36);
    const examScore = i === 14 ? 99 : Math.min(98, baseScore); // Clear unique highest exam_score (99) for student STU-1015 (age 21)
    const gpa = i === 7 ? 4.0 : Number(Math.min(3.96, 2.45 + ((examScore - 60) / 40) * 1.45 + ((i % 3) * 0.04)).toFixed(2));
    const scholarship = examScore >= 90 || gpa >= 3.8 ? scholarships[0] : examScore >= 80 ? scholarships[1] : scholarships[2];
    const gradYear = 2025 + (i % 4);

    rows.push({
      student_id: `STU-${1001 + i}`,
      full_name: `${first} ${last}`,
      age,
      gender,
      department: dept,
      gpa,
      exam_score: examScore,
      attendance_pct: attendance,
      study_hours_per_week: studyHours,
      scholarship_status: scholarship,
      graduation_year: gradYear,
    });
  }
  return rows;
}

function generateEcommerceOrderRows(): Array<Record<string, string | number>> {
  const customers = [
    'Northwind Studio', 'Apex Logistics', 'Crestline Retail', 'Vanguard Media', 'Solstice Cafe',
    'Meridian Health', 'Summit Outdoors', 'Harbor Design', 'Beacon Labs', 'Atlas Goods',
    'Kestrel Supply', 'Lumen Commerce', 'Oakridge Books', 'Cobalt Hardware', 'Terra Foods',
  ];
  const regions = ['North America', 'Europe', 'Asia Pacific', 'Latin America'];
  const categories = ['Electronics', 'Office Furniture', 'Cloud Software', 'Industrial Gear', 'Accessories'];
  const statuses = ['Delivered', 'Shipped', 'Processing', 'Returned'];

  const rows: Array<Record<string, string | number>> = [];
  for (let i = 0; i < 45; i++) {
    const month = String(1 + (i % 11)).padStart(2, '0');
    const day = String(1 + ((i * 3) % 27)).padStart(2, '0');
    const amount = Number((45 + ((i * 137) % 1850) + (i % 5) * 19.5).toFixed(2));
    const discount = (i % 4) * 5;
    const rating = Number((3.2 + ((i * 7) % 18) / 10).toFixed(1));

    rows.push({
      order_id: `ORD-${5001 + i}`,
      customer_name: customers[i % customers.length],
      region: regions[i % regions.length],
      product_category: categories[(i * 2) % categories.length],
      order_amount: amount,
      discount_pct: discount,
      customer_rating: Math.min(5.0, rating),
      order_date: `2026-${month}-${day}`,
      fulfillment_status: statuses[i % 9 === 0 ? 3 : i % 3],
    });
  }
  return rows;
}

function generateClinicalTrialRows(): Array<Record<string, string | number>> {
  const cohorts = ['Control', 'Dosage-Low', 'Dosage-High'];
  const arms = ['Placebo', 'Compound-A', 'Compound-B'];
  const rows: Array<Record<string, string | number>> = [];
  for (let i = 0; i < 40; i++) {
    const month = String(1 + (i % 10)).padStart(2, '0');
    const day = String(2 + ((i * 2) % 26)).padStart(2, '0');
    rows.push({
      patient_id: `PT-${201 + i}`,
      cohort: cohorts[i % cohorts.length],
      treatment_arm: arms[i % arms.length],
      age: 29 + ((i * 4) % 44),
      systolic_bp: 112 + ((i * 5) % 42),
      cholesterol_mg_dl: 162 + ((i * 9) % 88),
      bmi: Number((20.5 + ((i * 1.3) % 13.5)).toFixed(1)),
      outcome_score: Number((54 + ((i * 7.2) % 43)).toFixed(1)),
      visit_date: `2026-${month}-${day}`,
    });
  }
  return rows;
}

export const BUILTIN_DATASETS: BuiltinDatasetSeed[] = [
  {
    id: 'student_performance_data',
    name: 'Student Performance Data',
    tableName: 'student_performance_data',
    description: 'Academic performance, attendance, study habits, GPA, exam scores, and scholarship records for enrolled university students.',
    entityNoun: 'student',
    rows: generateStudentPerformanceRows(),
  },
  {
    id: 'ecommerce_orders',
    name: 'E-Commerce Orders',
    tableName: 'ecommerce_orders',
    description: 'B2B and retail order ledger tracking customer purchases, regional sales, product categories, discounts, ratings, and fulfillment status.',
    entityNoun: 'order',
    rows: generateEcommerceOrderRows(),
  },
  {
    id: 'clinical_trials',
    name: 'Clinical Trials & Vitals',
    tableName: 'clinical_trials',
    description: 'Clinical study patient measurements across control and dosage arms including blood pressure, cholesterol, BMI, and outcome scores.',
    entityNoun: 'patient',
    rows: generateClinicalTrialRows(),
  },
];
