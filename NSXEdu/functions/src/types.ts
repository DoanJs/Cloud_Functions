export interface Child {
  id: string;
  teacherIds: string[];
}

export interface Plan {
  id: string;
  childId: string;
  teacherIds: string[];
  status: string
}
export interface Report {
  id: string;
  childId: string;
  teacherIds: string[];
  status: string
}
